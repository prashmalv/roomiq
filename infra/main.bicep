/*============================================================================
  RoomIQ — Azure infrastructure
  Deploys: Container Registry, Linux App Service (container), PostgreSQL
  Flexible Server, Log Analytics + Application Insights.

  az group create -n rg-roomiq -l centralindia
  az deployment group create -g rg-roomiq -f infra/main.bicep \
     -p namePrefix=roomiq pgAdminPassword='<strong>' jwtSecret='<48 random bytes>'
============================================================================*/

@description('Lower-case prefix used for every resource name.')
@minLength(3)
@maxLength(16)
param namePrefix string = 'roomiq'

@description('Public web app name — becomes <name>.azurewebsites.net and must be globally unique. Empty keeps the suffixed default.')
param webAppName string = ''

@description('Pull images from ACR with the app\'s managed identity. Needs Owner or User Access Administrator to create the AcrPull assignment; with only Contributor set this false and the registry admin user is used instead.')
param useManagedIdentityForAcr bool = true

@description('Azure region. Central India / South India keep latency low for Indian offices.')
param location string = resourceGroup().location

@description('App Service Plan SKU. B1 is enough for a few hundred employees.')
@allowed(['B1', 'B2', 'P0v3', 'P1v3'])
param appSku string = 'B1'

@description('PostgreSQL compute tier.')
param pgSku string = 'Standard_B1ms'

param pgAdminUser string = 'roomiqadmin'

@secure()
@description('PostgreSQL administrator password.')
param pgAdminPassword string

@secure()
@description('Session signing key. openssl rand -base64 48')
param jwtSecret string

param appTimezone string = 'Asia/Kolkata'
param seedAdminEmail string = 'admin@uneecops.in'

@secure()
@minLength(12)
@description('Password for the bootstrap administrator, created only when the users table is empty. Without this the app falls back to the insecure default in config.js. Change it after first sign-in and drop the app setting.')
param seedAdminPassword string

@description('Provision Azure Communication Services Email and send through it. An Azure-managed domain needs no DNS and no mailbox, at the cost of a machine-generated sender address.')
param enableAcsEmail bool = true

@description('Where ACS keeps email data at rest. Must be a supported ACS data location.')
@allowed(['India', 'United States', 'Europe', 'Asia Pacific', 'UK', 'Australia'])
param acsDataLocation string = 'India'

@description('Ignored when enableAcsEmail is true — ACS then drives the transport.')
param mailDriver string = 'log'
param smtpHost string = ''
param smtpUser string = ''
@secure()
param smtpPass string = ''
param mailFrom string = 'RoomIQ <no-reply@uneecops.in>'

var registryCredentials = useManagedIdentityForAcr ? [] : [
  { name: 'DOCKER_REGISTRY_SERVER_USERNAME', value: acr.listCredentials().username }
  { name: 'DOCKER_REGISTRY_SERVER_PASSWORD', value: acr.listCredentials().passwords[0].value }
]

var suffix = uniqueString(resourceGroup().id)
var acrName = toLower('${namePrefix}acr${suffix}')
var appName = empty(webAppName) ? '${namePrefix}-app-${suffix}' : webAppName
var pgName  = '${namePrefix}-pg-${suffix}'
var dbName  = 'roomiq'

/*--------------------------------------------------------- observability ---*/
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-logs-${suffix}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${namePrefix}-ai-${suffix}'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

/*------------------------------------------------------------- registry ----*/
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: !useManagedIdentityForAcr }
}

/*------------------------------------------------------------ postgresql ---*/
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: pgName
  location: location
  sku: { name: pgSku, tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: pgAdminUser
    administratorLoginPassword: pgAdminPassword
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  parent: pg
  name: dbName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// App Service outbound IPs are dynamic on the Basic tier, so allow Azure services.
// Move to VNet integration + a private endpoint when the estate justifies it.
resource pgFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

// btree_gist backs the exclusion constraint that makes double-booking impossible.
// Azure blocks extensions that are not explicitly allow-listed on the server.
resource pgExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2023-06-01-preview' = {
  parent: pg
  name: 'azure.extensions'
  properties: { value: 'BTREE_GIST,PGCRYPTO', source: 'user-override' }
  dependsOn: [ pgDb ]
}

/*----------------------------------------------------------------- email ---*/
/* An Azure-managed domain is verified by Azure itself, so mail flows with no DNS
   record and no mailbox credential. The trade is the sender address: a generated
   <guid>.azurecomm.net. Pointing this at uneecops.in later means verifying a
   custom domain here — the application does not change. */
resource emailService 'Microsoft.Communication/emailServices@2023-04-01' = if (enableAcsEmail) {
  name: '${namePrefix}-email'
  location: 'global'
  properties: { dataLocation: acsDataLocation }
}

resource emailDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' = if (enableAcsEmail) {
  parent: emailService
  name: 'AzureManagedDomain'
  location: 'global'
  properties: {
    domainManagement: 'AzureManaged'
    userEngagementTracking: 'Disabled'
  }
}

resource comms 'Microsoft.Communication/communicationServices@2023-04-01' = if (enableAcsEmail) {
  name: '${namePrefix}-acs'
  location: 'global'
  properties: {
    dataLocation: acsDataLocation
    linkedDomains: [ emailDomain.id ]
  }
}

// NOTE: ARM does not reliably short-circuit the unused branch of a ternary that
// calls listKeys()/reference(). This is safe as deployed (enableAcsEmail true);
// flipping it to false on a stack whose ACS resources are gone may need the
// email block removed rather than merely disabled.
var acsSettings = enableAcsEmail ? [
  { name: 'MAIL_DRIVER', value: 'acs' }
  { name: 'ACS_ENDPOINT', value: 'https://${comms.properties.hostName}' }
  { name: 'ACS_ACCESS_KEY', value: comms.listKeys().primaryKey }
  { name: 'MAIL_FROM', value: 'RoomIQ <donotreply@${emailDomain.properties.fromSenderDomain}>' }
] : [
  { name: 'MAIL_DRIVER', value: mailDriver }
  { name: 'MAIL_FROM', value: mailFrom }
]

/*--------------------------------------------------------------- compute ---*/
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${namePrefix}-plan-${suffix}'
  location: location
  sku: { name: appSku }
  kind: 'linux'
  properties: { reserved: true }
}

resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  kind: 'app,linux,container'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'DOCKER|${acr.properties.loginServer}/roomiq:latest'
      acrUseManagedIdentityCreds: useManagedIdentityForAcr
      alwaysOn: appSku != 'B1' ? true : false
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      healthCheckPath: '/healthz'
      appSettings: concat([
        { name: 'WEBSITES_PORT', value: '8080' }
        { name: 'DOCKER_REGISTRY_SERVER_URL', value: 'https://${acr.properties.loginServer}' }
        { name: 'NODE_ENV', value: 'production' }
        { name: 'PORT', value: '8080' }
        { name: 'DATABASE_URL', value: 'postgres://${pgAdminUser}:${uriComponent(pgAdminPassword)}@${pg.properties.fullyQualifiedDomainName}:5432/${dbName}?sslmode=require' }
        { name: 'PGSSL', value: 'true' }
        { name: 'JWT_SECRET', value: jwtSecret }
        { name: 'COOKIE_SECURE', value: 'true' }
        { name: 'APP_TIMEZONE', value: appTimezone }
        { name: 'PUBLIC_URL', value: 'https://${appName}.azurewebsites.net' }
        { name: 'SEED_ADMIN_EMAIL', value: seedAdminEmail }
        { name: 'SEED_ADMIN_PASSWORD', value: seedAdminPassword }
        { name: 'SEED_DEMO_DATA', value: 'false' }
        { name: 'SMTP_HOST', value: smtpHost }
        { name: 'SMTP_PORT', value: '587' }
        { name: 'SMTP_USER', value: smtpUser }
        { name: 'SMTP_PASS', value: smtpPass }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
      ], registryCredentials, acsSettings)
    }
  }
}

// AcrPull for the app's managed identity — no registry admin password anywhere.
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (useManagedIdentityForAcr) {
  scope: acr
  name: guid(acr.id, app.id, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource appLogs 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: app
  name: 'logs'
  properties: {
    httpLogs: { fileSystem: { enabled: true, retentionInDays: 7, retentionInMb: 35 } }
    applicationLogs: { fileSystem: { level: 'Warning' } }
  }
}

/*--------------------------------------------------------------- outputs ---*/
output appUrl string = 'https://${app.properties.defaultHostName}'
output acrLoginServer string = acr.properties.loginServer
output acrName string = acr.name
output webAppName string = app.name
output postgresHost string = pg.properties.fullyQualifiedDomainName
output mailSender string = enableAcsEmail ? 'donotreply@${emailDomain.properties.fromSenderDomain}' : mailFrom
