___TERMS_OF_SERVICE___

By creating or modifying this file you agree to Google Tag Manager's Community
Template Gallery Developer Terms of Service available at
https://developers.google.com/tag-manager/gallery-tos (or such other URL as
Google may provide), as modified from time to time.


___INFO___

{
  "type": "CLIENT",
  "id": "cvt_temp_public_id",
  "version": 1,
  "securityGroups": [],
  "displayName": "SharedID echo (SharedID Edge tests)",
  "brand": {
    "id": "brand_dummy",
    "displayName": "SharedID Edge"
  },
  "description": "Test fixture for SharedID Edge's sGTM tests (e2e/sgtm). Claims requests to one path and runs the container with an event named sid_echo, so the SharedID echo tag can answer with the SharedID variable's value. Not for production containers.",
  "containerContexts": [
    "SERVER"
  ]
}


___TEMPLATE_PARAMETERS___

[
  {
    "type": "TEXT",
    "name": "path",
    "displayName": "Path to claim",
    "simpleValueType": true,
    "defaultValue": "/metrics/sid-echo",
    "help": "The request path this client claims, exactly, with the path the tagging server is served on.",
    "valueValidators": [
      {
        "type": "NON_EMPTY"
      }
    ]
  }
]


___SANDBOXED_JS_FOR_SERVER___

// A test fixture from SharedID Edge (https://github.com/patmmccann/sharedid-edge, e2e/sgtm). Apache-2.0.
// It claims requests to one path and runs the container with an event that carries nothing from the request, so
// the SharedID echo tag answers with the SharedID variable's value, which the variable reads from the request's
// cookies. It reads only the request path.

const claimRequest = require('claimRequest');
const getRequestPath = require('getRequestPath');
const returnResponse = require('returnResponse');
const runContainer = require('runContainer');

if (getRequestPath() === data.path) {
  claimRequest();
  runContainer({event_name: 'sid_echo'}, () => returnResponse());
}


___SERVER_PERMISSIONS___

[
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
          "key": "pathAllowed",
          "value": {
            "type": 8,
            "boolean": true
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
        "publicId": "run_container",
        "versionId": "1"
      },
      "param": []
    },
    "isRequired": true
  },
  {
    "instance": {
      "key": {
        "publicId": "return_response",
        "versionId": "1"
      },
      "param": []
    },
    "isRequired": true
  }
]


___TESTS___

scenarios: []


___NOTES___

From SharedID Edge (https://github.com/patmmccann/sharedid-edge), e2e/sgtm: a test fixture.
