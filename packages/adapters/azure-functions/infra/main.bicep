// SharedID Edge on Azure Functions behind your site's Azure Front Door (Standard or Premium).
//
// Creates a Function app on the Flex Consumption plan (Node.js 24), its storage account, and, on your existing Front
// Door profile, an origin group, an origin and a route for SID_BASE_PATH (/_sid/* by default) on the custom domains
// that serve your site, with caching off. The function app accepts traffic only from your Front Door profile: an
// access restriction allows the AzureFrontDoor.Backend service tag with your profile's X-Azure-FDID, and the handler
// checks X-Azure-FDID too (SID_FRONT_DOOR_ID).
//
// It doesn't deploy the code: publish deploy/ afterwards (see the README). Deploy into the resource group for the
// function app; the Front Door profile may be in another resource group of the same subscription.

targetScope = 'resourceGroup'

import { normalizeBasePath } from 'basepath.bicep'

@description('Region for the function app and its storage.')
param location string = resourceGroup().location

@description('Name of the function app (globally unique; its host name is <name>.azurewebsites.net).')
param appName string = 'sid-${uniqueString(resourceGroup().id)}'

@description('Name of your existing Front Door profile (Standard or Premium) that serves your site.')
param frontDoorProfileName string

@description('Resource group of the Front Door profile.')
param frontDoorResourceGroup string = resourceGroup().name

@description('Name of the Front Door endpoint that serves your site.')
param frontDoorEndpointName string

@description('Names of the profile\'s custom domains that serve your site (e.g. www-example-com). The route must be on the same domains as your pages. Empty: the endpoint\'s own azurefd.net domain, for trying it out.')
param customDomainNames array = []

@description('Add a rule set that passes Front Door\'s {geo_country} to the function as x-sid-country, so GDPR can apply by country and the geo module gets the country.')
param addCountryHeader bool = true

@description('Node.js version of the Flex Consumption runtime.')
param nodeVersion string = '24'

@description('Maximum number of instances.')
@minValue(40)
param maximumInstanceCount int = 100

@description('SID_BASE_PATH: the path the endpoint answers under, like /_sid, or / for /sync, /v1, /optout and /optin at the root. The function route and the Front Door route follow it, normalized as core does (/identity/ is /identity); an invalid value fails the deployment.')
param sidBasePath string = '/_sid'
@description('SID_COOKIE_NAME (empty: _pubcid)')
param sidCookieName string = ''
@description('SID_COOKIE_DOMAIN, e.g. .example.com (empty: host-only)')
param sidCookieDomain string = ''
@description('SID_MAX_AGE_DAYS (empty: 365)')
param sidMaxAgeDays string = ''
@description('SID_CREATE (empty: true)')
param sidCreate string = ''
@description('SID_RECOVERY_COOKIE (empty: _pubcid_sv)')
param sidRecoveryCookie string = ''
@description('SID_OPTOUT_COOKIE (empty: _pubcid_optout)')
param sidOptoutCookie string = ''
@description('SID_VENDOR_ID (empty: publisher mode)')
param sidVendorId string = ''
@description('SID_ALLOWED_ORIGINS (empty: none)')
param sidAllowedOrigins string = ''
@description('SID_SYNC_CACHE_SECONDS (empty: 86400)')
param sidSyncCacheSeconds string = ''
@description('SID_MODULES, e.g. ip,geo (empty: none)')
param sidModules string = ''
@description('SID_SYNC_MODULES: the modules in SID_MODULES that also run on /sync, e.g. reflect, or none (empty: those whose routes include sync)')
param sidSyncModules string = ''
@description('SID_MODULE_CONFIG (JSON; empty: {})')
param sidModuleConfig string = ''
@description('SID_MODULE_TIMEOUT_MS (empty: 50)')
param sidModuleTimeoutMs string = ''
@description('SID_MODULE_SECRETS (JSON), or a Key Vault reference: @Microsoft.KeyVault(SecretUri=...)')
@secure()
param sidModuleSecrets string = ''

var countryHeader = 'x-sid-country'
// Checked and normalized as core does: the function's route and the Front Door patterns both come from it.
var basePath = normalizeBasePath(sidBasePath)
var deploymentContainer = 'deployments'
// Storage Blob Data Owner: the function app reads its package and keeps its host state in the storage account.
var storageBlobDataOwner = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'

resource frontDoor 'Microsoft.Cdn/profiles@2024-02-01' existing = {
  name: frontDoorProfileName
  scope: resourceGroup(frontDoorResourceGroup)
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take('sid${uniqueString(resourceGroup().id, appName)}', 24)
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: deploymentContainer
}

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${appName}-plan'
  location: location
  kind: 'functionapp'
  sku: { name: 'FC1', tier: 'FlexConsumption' }
  properties: { reserved: true }
}

resource app 'Microsoft.Web/sites@2024-04-01' = {
  name: appName
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      // Only your Front Door profile: the AzureFrontDoor.Backend service tag covers every Front Door profile, so the
      // X-Azure-FDID header filter narrows it to yours.
      ipSecurityRestrictionsDefaultAction: 'Deny'
      ipSecurityRestrictions: [
        {
          name: 'front-door'
          action: 'Allow'
          priority: 100
          tag: 'ServiceTag'
          ipAddress: 'AzureFrontDoor.Backend'
          headers: {
            'x-azure-fdid': [
              frontDoor.properties.frontDoorId
            ]
          }
        }
      ]
      scmIpSecurityRestrictionsUseMain: false
      appSettings: [
        { name: 'AzureWebJobsStorage__accountName', value: storage.name }
        { name: 'SID_FRONT_DOOR_ID', value: frontDoor.properties.frontDoorId }
        { name: 'SID_LOCATION_HEADERS', value: addCountryHeader ? '{"country":"${countryHeader}"}' : '' }
        { name: 'SID_BASE_PATH', value: basePath }
        { name: 'SID_COOKIE_NAME', value: sidCookieName }
        { name: 'SID_COOKIE_DOMAIN', value: sidCookieDomain }
        { name: 'SID_MAX_AGE_DAYS', value: sidMaxAgeDays }
        { name: 'SID_CREATE', value: sidCreate }
        { name: 'SID_RECOVERY_COOKIE', value: sidRecoveryCookie }
        { name: 'SID_OPTOUT_COOKIE', value: sidOptoutCookie }
        { name: 'SID_VENDOR_ID', value: sidVendorId }
        { name: 'SID_ALLOWED_ORIGINS', value: sidAllowedOrigins }
        { name: 'SID_SYNC_CACHE_SECONDS', value: sidSyncCacheSeconds }
        { name: 'SID_MODULES', value: sidModules }
        { name: 'SID_SYNC_MODULES', value: sidSyncModules }
        { name: 'SID_MODULE_CONFIG', value: sidModuleConfig }
        { name: 'SID_MODULE_TIMEOUT_MS', value: sidModuleTimeoutMs }
        { name: 'SID_MODULE_SECRETS', value: sidModuleSecrets }
      ]
    }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deploymentContainer}'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: maximumInstanceCount
        instanceMemoryMB: 512
      }
      runtime: { name: 'node', version: nodeVersion }
    }
  }
  dependsOn: [container]
}

resource blobOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, app.id, storageBlobDataOwner)
  scope: storage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataOwner)
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

module route 'frontdoor.bicep' = {
  name: 'sharedid-edge-front-door'
  scope: resourceGroup(frontDoorResourceGroup)
  params: {
    profileName: frontDoorProfileName
    endpointName: frontDoorEndpointName
    customDomainNames: customDomainNames
    originHostName: app.properties.defaultHostName
    basePath: basePath
    countryHeader: addCountryHeader ? countryHeader : ''
    namePrefix: 'sharedid-edge'
  }
}

output functionAppName string = app.name
output functionAppHostName string = app.properties.defaultHostName
output frontDoorId string = frontDoor.properties.frontDoorId
output routePatterns array = route.outputs.patterns
