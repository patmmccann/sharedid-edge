___TERMS_OF_SERVICE___

By creating or modifying this file you agree to Google Tag Manager's Community
Template Gallery Developer Terms of Service available at
https://developers.google.com/tag-manager/gallery-tos (or such other URL as
Google may provide), as modified from time to time.


___INFO___

{
  "type": "TAG",
  "id": "cvt_temp_public_id",
  "version": 1,
  "securityGroups": [],
  "displayName": "SharedID echo response (SharedID Edge tests)",
  "brand": {
    "id": "brand_dummy",
    "displayName": "SharedID Edge"
  },
  "description": "Test fixture for SharedID Edge's sGTM tests (e2e/sgtm). Answers the SharedID echo client's request with JSON holding one value, normally {{SharedID}}: {\"sharedid\":\"<id>\"}, or {\"sharedid\":null}. Not for production containers.",
  "containerContexts": [
    "SERVER"
  ]
}


___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "sharedid",
    "displayName": "SharedID",
    "simpleValueType": true,
    "help": "The value to answer with: the SharedID variable, {{SharedID}}."
  }
]


___SANDBOXED_JS_FOR_SERVER___

// A test fixture from SharedID Edge (https://github.com/patmmccann/sharedid-edge, e2e/sgtm). Apache-2.0.
// It writes the echo client's response: the field's value and nothing else from the request.

const JSON = require('JSON');
const getType = require('getType');
const setResponseBody = require('setResponseBody');
const setResponseHeader = require('setResponseHeader');
const setResponseStatus = require('setResponseStatus');

const value = data.sharedid;
// The variable returns undefined when there is no ID; a field that holds only a variable passes its value as it is.
const sharedid = getType(value) === 'string' && value !== '' ? value : null;

setResponseStatus(200);
setResponseHeader('content-type', 'application/json');
setResponseHeader('cache-control', 'no-store');
setResponseBody(JSON.stringify({sharedid: sharedid}));
data.gtmOnSuccess();


___SERVER_PERMISSIONS___

[
  {
    "instance": {
      "key": {
        "publicId": "access_response",
        "versionId": "1"
      },
      "param": [
        {
          "key": "writeResponseAccess",
          "value": {
            "type": 1,
            "string": "specific"
          }
        },
        {
          "key": "writeStatusAllowed",
          "value": {
            "type": 8,
            "boolean": true
          }
        },
        {
          "key": "writeBodyAllowed",
          "value": {
            "type": 8,
            "boolean": true
          }
        },
        {
          "key": "writeHeadersAllowed",
          "value": {
            "type": 8,
            "boolean": true
          }
        },
        {
          "key": "writeHeaderAccess",
          "value": {
            "type": 1,
            "string": "specific"
          }
        },
        {
          "key": "writeHeaderWhitelist",
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
                    "string": "content-type"
                  }
                ]
              },
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
                    "string": "cache-control"
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

scenarios: []


___NOTES___

From SharedID Edge (https://github.com/patmmccann/sharedid-edge), e2e/sgtm: a test fixture.
