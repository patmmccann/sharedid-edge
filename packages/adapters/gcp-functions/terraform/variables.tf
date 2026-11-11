variable "project" {
  description = "Google Cloud project of your site's load balancer."
  type        = string
}

variable "region" {
  description = "Region for the function (a serverless NEG is regional; the global load balancer reaches it from everywhere)."
  type        = string
}

variable "name" {
  description = "Name of the function, its Cloud Run service, NEG and backend service."
  type        = string
  default     = "sharedid-edge"
}

variable "source_dir" {
  description = "The function's source: deploy/, built by `npm run bundle -w @sharedid-edge/gcp-functions`."
  type        = string
  default     = "../deploy"
}

variable "load_balancing_scheme" {
  description = "Your URL map's load balancer: EXTERNAL_MANAGED (global external Application Load Balancer) or EXTERNAL (classic)."
  type        = string
  default     = "EXTERNAL_MANAGED"
}

variable "max_instance_count" {
  description = "Maximum number of instances."
  type        = number
  default     = 100
}

variable "min_instance_count" {
  description = "Instances kept warm, to avoid cold starts (each one costs a baseline)."
  type        = number
  default     = 0
}

variable "location_headers" {
  description = "Add the visitor's location as custom request headers on the backend service ({client_region}, {client_region_subdivision}, {client_city}, {client_city_lat_long}) and read them (SID_LOCATION_HEADERS)."
  type        = bool
  default     = true
}

variable "sid_trusted_hops" {
  description = "SID_TRUSTED_HOPS: X-Forwarded-For entries your infrastructure appends after the client's address. 1 behind the external Application Load Balancer."
  type        = string
  default     = "1"
}

variable "sid_module_secrets_secret" {
  description = "Secret Manager secret (its ID in this project) holding SID_MODULE_SECRETS, or empty for none."
  type        = string
  default     = ""
}

variable "sid_base_path" {
  description = "SID_BASE_PATH. The URL map's path rule (the path_rule_paths output) follows it; / serves core's four routes at the root."
  type        = string
  default     = "/_sid"

  validation {
    condition     = can(regex("^/[A-Za-z0-9._~/-]*$", var.sid_base_path)) && !strcontains(var.sid_base_path, "//")
    error_message = "sid_base_path must be a path like /_sid (letters, digits, . _ ~ - and /), or /."
  }
}

variable "sid_cookie_name" {
  description = "SID_COOKIE_NAME (empty: _pubcid)"
  type        = string
  default     = ""
}

variable "sid_cookie_domain" {
  description = "SID_COOKIE_DOMAIN (required): the domain Prebid.js writes the SharedID cookie on, normally your registrable domain (example.com); host-only for cookies without a Domain"
  type        = string

  validation {
    condition     = length(var.sid_cookie_domain) > 0
    error_message = "Set sid_cookie_domain to the domain Prebid.js writes the SharedID cookie on (example.com), or host-only."
  }
}

variable "sid_max_age_days" {
  description = "SID_MAX_AGE_DAYS (empty: 365)"
  type        = string
  default     = ""
}

variable "sid_create" {
  description = "SID_CREATE (empty: true)"
  type        = string
  default     = ""
}

variable "sid_recovery_cookie" {
  description = "SID_RECOVERY_COOKIE (empty: _pubcid_sv)"
  type        = string
  default     = ""
}

variable "sid_optout_cookie" {
  description = "SID_OPTOUT_COOKIE (empty: _pubcid_optout)"
  type        = string
  default     = ""
}

variable "sid_vendor_id" {
  description = "SID_VENDOR_ID (empty: publisher mode)"
  type        = string
  default     = ""
}

variable "sid_allowed_origins" {
  description = "SID_ALLOWED_ORIGINS (empty: none)"
  type        = string
  default     = ""
}

variable "sid_sync_cache_seconds" {
  description = "SID_SYNC_CACHE_SECONDS (empty: 86400)"
  type        = string
  default     = ""
}

variable "sid_modules" {
  description = "SID_MODULES, e.g. ip,geo (empty: none)"
  type        = string
  default     = ""
}

variable "sid_module_config" {
  description = "SID_MODULE_CONFIG (JSON; empty: {})"
  type        = string
  default     = ""
}

variable "sid_module_timeout_ms" {
  description = "SID_MODULE_TIMEOUT_MS (empty: 50)"
  type        = string
  default     = ""
}

variable "sid_sync_modules" {
  description = "SID_SYNC_MODULES (empty: none)"
  type        = string
  default     = ""
}

variable "sid_skip_bots" {
  description = "SID_SKIP_BOTS (empty: off)"
  type        = string
  default     = ""
}

variable "sid_skip_bots_score" {
  description = "SID_SKIP_BOTS_SCORE (empty: off)"
  type        = string
  default     = ""
}
