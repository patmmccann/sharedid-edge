// The Front Door part of main.bicep, deployed to the Front Door profile's resource group: an origin group and origin
// for the function app, an optional rule set that adds the visitor's country, and a route for the base path on your
// site's custom domains, with caching off (no cacheConfiguration).

@description('Existing Front Door profile (Standard or Premium).')
param profileName string

@description('Existing endpoint of the profile.')
param endpointName string

@description('Existing custom domains of the profile that serve your site. Empty: the endpoint\'s own domain.')
param customDomainNames array

@description('The function app\'s host name.')
param originHostName string

@description('SID_BASE_PATH.')
param basePath string

@description('Request header to set from {geo_country}; empty for none.')
param countryHeader string

@description('Prefix for the names of the resources this creates.')
param namePrefix string

// The paths Front Door sends to the function: the base path and everything under it, or with the root base path
// only the endpoint's own four routes (the rest of the site stays on its origin).
var corePaths = ['/sync', '/v1', '/optout', '/optin']
var patterns = basePath == '/' ? flatten(map(corePaths, p => [p, '${p}/'])) : [basePath, '${basePath}/*']

resource profile 'Microsoft.Cdn/profiles@2024-02-01' existing = {
  name: profileName

  resource endpoint 'afdEndpoints' existing = {
    name: endpointName
  }
}

resource domains 'Microsoft.Cdn/profiles/customDomains@2024-02-01' existing = [for name in customDomainNames: {
  parent: profile
  name: name
}]

resource originGroup 'Microsoft.Cdn/profiles/originGroups@2024-02-01' = {
  parent: profile
  name: '${namePrefix}-origins'
  properties: {
    loadBalancingSettings: {
      sampleSize: 4
      successfulSamplesRequired: 3
      additionalLatencyInMilliseconds: 50
    }
    sessionAffinityState: 'Disabled'
  }
}

resource origin 'Microsoft.Cdn/profiles/originGroups/origins@2024-02-01' = {
  parent: originGroup
  name: '${namePrefix}-function'
  properties: {
    hostName: originHostName
    // The function app's own host name: App Service routes by it.
    originHostHeader: originHostName
    httpPort: 80
    httpsPort: 443
    priority: 1
    weight: 1000
    enabledState: 'Enabled'
    enforceCertificateNameCheck: true
  }
}

resource ruleSet 'Microsoft.Cdn/profiles/ruleSets@2024-02-01' = if (countryHeader != '') {
  parent: profile
  name: replace('${namePrefix}country', '-', '')
}

resource countryRule 'Microsoft.Cdn/profiles/ruleSets/rules@2024-02-01' = if (countryHeader != '') {
  parent: ruleSet
  name: 'country'
  properties: {
    order: 1
    conditions: []
    actions: [
      {
        name: 'ModifyRequestHeader'
        parameters: {
          typeName: 'DeliveryRuleHeaderActionParameters'
          // Overwrite: a copy the visitor sends is replaced on every request. Empty when Front Door doesn't know the
          // country, which the function treats as unknown.
          headerAction: 'Overwrite'
          headerName: countryHeader
          value: '{geo_country}'
        }
      }
    ]
    matchProcessingBehavior: 'Continue'
  }
}

resource route 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = {
  parent: profile::endpoint
  name: namePrefix
  properties: {
    originGroup: { id: originGroup.id }
    patternsToMatch: patterns
    supportedProtocols: ['Http', 'Https']
    httpsRedirect: 'Enabled'
    forwardingProtocol: 'HttpsOnly'
    // No cacheConfiguration: caching is off, so per-visitor responses are never shared.
    customDomains: [for (name, i) in customDomainNames: { id: domains[i].id }]
    linkToDefaultDomain: empty(customDomainNames) ? 'Enabled' : 'Disabled'
    ruleSets: countryHeader == '' ? [] : [{ id: ruleSet.id }]
    enabledState: 'Enabled'
  }
  dependsOn: [origin, countryRule]
}

output patterns array = patterns
