// The e2e page's GPP consent, for Prebid.js's GPP consent management (consentManagement.gpp, cmpApi 'static'), which
// with pixelConsent: true sends it to pixelUrl as gpp and gpp_sid. The page picks a scenario with ?gpp=<name>; without
// it, the page has no GPP CMP. See e2e/AGENTS.md.
//
// GPP strings from conformance/cases/module-gpp.json, encoded with the IAB reference library (@iabgpp/cmpapi):
//   usnatOptOut:          US National v2, SaleOptOut=1 (opted out of sale); applicable section 7.
//   usnatNoOptOut:        US National v2, every opt-out 2 (did not opt out); applicable section 7.
//   tcfEuAndUsnatOptOut:  TCF EU v2 and US National with SaleOptOut=1; applicable sections 2 and 7.
window.SID_E2E_GPP = (function () {
  var scenarios = {
    usnatOptOut: { gppString: 'DBABLA~CVQaAAAAAABA.QA', applicableSections: [7] },
    usnatNoOptOut: { gppString: 'DBABLA~CVQqAAAAAABA.QA', applicableSections: [7] },
    tcfEuAndUsnatOptOut: { gppString: 'DBACMMA~CQt0_oAQt0_oAAfAAAENAAFgAAAAAAAAAAAAAAAAAAAA.IAAA.YAAAAAAAAAAA~CAAQAAAAAABA.QA', applicableSections: [2, 7] }
  };
  var name = new URLSearchParams(location.search).get('gpp');
  if (name === null) return undefined;
  if (!(name in scenarios)) throw new Error('unknown GPP scenario: ' + name);
  var scenario = scenarios[name];
  return { gppVersion: '1.1', cmpStatus: 'loaded', signalStatus: 'ready', gppString: scenario.gppString, applicableSections: scenario.applicableSections, parsedSections: {} };
})();
