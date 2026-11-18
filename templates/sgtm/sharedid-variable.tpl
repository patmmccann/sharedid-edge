___TERMS_OF_SERVICE___

By creating or modifying this file you agree to Google Tag Manager's Community
Template Gallery Developer Terms of Service available at
https://developers.google.com/tag-manager/gallery-tos (or such other URL as
Google may provide), as modified from time to time.


___INFO___

{
  "type": "MACRO",
  "id": "cvt_temp_public_id",
  "version": 1,
  "securityGroups": [],
  "displayName": "SharedID (SharedID Edge)",
  "categories": [
    "UTILITY",
    "ADVERTISING"
  ],
  "brand": {
    "id": "brand_dummy",
    "displayName": "SharedID Edge"
  },
  "description": "Returns the visitor's Prebid SharedID from the _pubcid cookie that SharedID Edge sets, or undefined when there is none, the visitor opted out, or sends Global Privacy Control. Reads cookies only; sends nothing.",
  "containerContexts": [
    "SERVER"
  ]
}


___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "cookieName",
    "displayName": "SharedID cookie",
    "simpleValueType": true,
    "defaultValue": "_pubcid",
    "help": "SharedID Edge's SID_COOKIE_NAME. If you change it, add the new name to this template's <b>Reads cookie value(s)</b> permission.",
    "valueValidators": [
      {
        "type": "NON_EMPTY"
      }
    ]
  },
  {
    "type": "TEXT",
    "name": "recoveryCookieName",
    "displayName": "Recovery cookie (HttpOnly copy)",
    "simpleValueType": true,
    "defaultValue": "_pubcid_sv",
    "help": "SharedID Edge's SID_RECOVERY_COOKIE. It is read first, as SharedID Edge does: when it differs from the SharedID cookie, the page re-minted the ID after Safari capped it, and SharedID Edge restores this value on its next call. Leave empty to read the SharedID cookie only."
  },
  {
    "type": "TEXT",
    "name": "optOutCookieName",
    "displayName": "Opt-out cookie",
    "simpleValueType": true,
    "defaultValue": "_pubcid_optout",
    "help": "When this cookie is present, the variable returns undefined, as SharedID Edge and Prebid.js set no ID. Leave empty to ignore it."
  },
  {
    "type": "CHECKBOX",
    "name": "honorGpc",
    "checkboxText": "Return undefined for requests with Global Privacy Control (Sec-GPC: 1)",
    "simpleValueType": true,
    "defaultValue": true,
    "help": "SharedID Edge sets no ID for these requests and deletes the ID cookies on its next call; until then the browser may still send them."
  }
]


___SANDBOXED_JS_FOR_SERVER___

// SharedID variable for server-side Google Tag Manager, from SharedID Edge
// (https://github.com/patmmccann/sharedid-edge, templates/sgtm). Apache-2.0.
// It reads the SharedID cookies from the incoming request, as SharedID Edge's
// specification (spec/SPEC.md, "The ID") chooses between them, and calls
// nothing else.

const createRegex = require('createRegex');
const getCookieValues = require('getCookieValues');
const getRequestHeader = require('getRequestHeader');
const getType = require('getType');
const testRegex = require('testRegex');

// A valid ID, as in SharedID Edge's specification. createRegex returns null
// on server images older than 2.0.0, and then no ID is returned.
const validId = createRegex('^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$');

function named(value) {
  return getType(value) === 'string' && value !== '';
}

// Browsers send cookies of the same name oldest first, and SharedID Edge
// uses the first one; a first value that isn't a valid ID doesn't count.
// Values are read as sent (noDecode), as SharedID Edge reads them: a
// percent-encoded value isn't a valid ID there, so it mustn't be one here.
function firstValid(name) {
  if (!named(name) || validId === null) return undefined;
  const value = getCookieValues(name, true)[0];
  if (getType(value) !== 'string' || !testRegex(validId, value)) return undefined;
  return value;
}

if (named(data.optOutCookieName) && getCookieValues(data.optOutCookieName).length > 0) {
  return undefined;
}
if (data.honorGpc && getRequestHeader('sec-gpc') === '1') {
  return undefined;
}

const recovered = firstValid(data.recoveryCookieName);
return recovered !== undefined ? recovered : firstValid(data.cookieName);


___SERVER_PERMISSIONS___

[
  {
    "instance": {
      "key": {
        "publicId": "get_cookies",
        "versionId": "1"
      },
      "param": [
        {
          "key": "cookieAccess",
          "value": {
            "type": 1,
            "string": "specific"
          }
        },
        {
          "key": "cookieNames",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 1,
                "string": "_pubcid"
              },
              {
                "type": 1,
                "string": "_pubcid_sv"
              },
              {
                "type": 1,
                "string": "_pubcid_optout"
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "read_request",
        "versionId": "1"
      },
      "param": [
        {
          "key": "requestAccess",
          "value": {
            "type": 1,
            "string": "specific"
          }
        },
        {
          "key": "headersAllowed",
          "value": {
            "type": 8,
            "boolean": true
          }
        },
        {
          "key": "headerAccess",
          "value": {
            "type": 1,
            "string": "specific"
          }
        },
        {
          "key": "headerWhitelist",
          "value": {
            "type": 2,
            "listItem": [
              {
                "type": 3,
                "mapKey": [
                  {
                    "type": 1,
                    "string": "headerName"
                  }
                ],
                "mapValue": [
                  {
                    "type": 1,
                    "string": "sec-gpc"
                  }
                ]
              }
            ]
          }
        }
      ]
    },
    "clientAnnotations": {
      "isEditedByUser": true
    },
    "isRequired": true
  }
]


___TESTS___

scenarios:
- name: Returns the SharedID cookie
  code: |-
    mockCookies({_pubcid: ['c29cb2ae-769d-42f6-891a-f53cadee823d']});
    assertThat(runCode(defaults)).isEqualTo('c29cb2ae-769d-42f6-891a-f53cadee823d');
- name: Prefers the recovery copy, as SharedID Edge does
  code: |-
    mockCookies({_pubcid: ['0f0e6fd3-2a43-4d0b-9e5b-0c6f5a1f8a10'], _pubcid_sv: ['c29cb2ae-769d-42f6-891a-f53cadee823d']});
    assertThat(runCode(defaults)).isEqualTo('c29cb2ae-769d-42f6-891a-f53cadee823d');
- name: Uses the first of duplicate cookies
  code: |-
    mockCookies({_pubcid: ['c29cb2ae-769d-42f6-891a-f53cadee823d', '0f0e6fd3-2a43-4d0b-9e5b-0c6f5a1f8a10']});
    assertThat(runCode(defaults)).isEqualTo('c29cb2ae-769d-42f6-891a-f53cadee823d');
- name: Skips an invalid recovery copy
  code: |-
    mockCookies({_pubcid: ['c29cb2ae-769d-42f6-891a-f53cadee823d'], _pubcid_sv: ['not valid!']});
    assertThat(runCode(defaults)).isEqualTo('c29cb2ae-769d-42f6-891a-f53cadee823d');
- name: Reads values undecoded, so a percent-encoded recovery copy isn't valid
  code: |-
    mock('getCookieValues', (name, noDecode) => {
      if (name === '_pubcid_sv') return [noDecode ? '%41' : 'A'];
      return name === '_pubcid' ? ['c29cb2ae-769d-42f6-891a-f53cadee823d'] : [];
    });
    assertThat(runCode(defaults)).isEqualTo('c29cb2ae-769d-42f6-891a-f53cadee823d');
- name: Returns undefined without a cookie
  code: |-
    mockCookies({});
    assertThat(runCode(defaults)).isUndefined();
- name: Returns undefined after opt-out
  code: |-
    mockCookies({_pubcid: ['c29cb2ae-769d-42f6-891a-f53cadee823d'], _pubcid_optout: ['1']});
    assertThat(runCode(defaults)).isUndefined();
- name: Returns undefined with Global Privacy Control
  code: |-
    mockCookies({_pubcid: ['c29cb2ae-769d-42f6-891a-f53cadee823d']});
    mock('getRequestHeader', name => name === 'sec-gpc' ? '1' : undefined);
    assertThat(runCode(defaults)).isUndefined();
- name: Ignores Global Privacy Control when unticked
  code: |-
    mockCookies({_pubcid: ['c29cb2ae-769d-42f6-891a-f53cadee823d']});
    mock('getRequestHeader', name => name === 'sec-gpc' ? '1' : undefined);
    assertThat(runCode({cookieName: '_pubcid', recoveryCookieName: '_pubcid_sv', optOutCookieName: '_pubcid_optout', honorGpc: false})).isEqualTo('c29cb2ae-769d-42f6-891a-f53cadee823d');
- name: Reads only the SharedID cookie when the recovery cookie is empty
  code: |-
    mockCookies({_pubcid: ['c29cb2ae-769d-42f6-891a-f53cadee823d'], _pubcid_sv: ['0f0e6fd3-2a43-4d0b-9e5b-0c6f5a1f8a10']});
    assertThat(runCode({cookieName: '_pubcid', recoveryCookieName: '', optOutCookieName: '_pubcid_optout', honorGpc: true})).isEqualTo('c29cb2ae-769d-42f6-891a-f53cadee823d');
setup: |-
  const defaults = {cookieName: '_pubcid', recoveryCookieName: '_pubcid_sv', optOutCookieName: '_pubcid_optout', honorGpc: true};
  function mockCookies(cookies) {
    mock('getCookieValues', name => cookies[name] || []);
  }
  mock('getRequestHeader', name => undefined);


___NOTES___

From SharedID Edge (https://github.com/patmmccann/sharedid-edge), templates/sgtm.
See its README for importing, permissions and an example.
