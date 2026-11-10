# SharedID Edge as a Cloud Run function (Node.js 24) behind your site's external Application Load Balancer.
#
# Creates the function (ingress: internal and Cloud Load Balancing only), its service account, a serverless network
# endpoint group and a backend service with Cloud CDN off and the visitor's location as custom request headers. It
# doesn't change your URL map: add a path rule for the path_rule_paths output to the backend_service output (see the
# README), on the host rule that serves your site, so /_sid/* is on your site's own host name and IP addresses.

locals {
  # The custom request headers the backend service adds, by location field (SID_LOCATION_HEADERS). The load balancer
  # overwrites headers of these names that a visitor sends.
  location_headers = {
    country = "x-client-region"
    region  = "x-client-region-subdivision"
    city    = "x-client-city"
    latLong = "x-client-city-lat-long"
  }
  location_variables = {
    country = "{client_region}"
    region  = "{client_region_subdivision}"
    city    = "{client_city}"
    latLong = "{client_city_lat_long}"
  }
  # SID_BASE_PATH as core normalizes it: trailing slashes off (/identity/ is /identity), / stays /.
  trimmed   = replace(var.sid_base_path, "/\\/+$/", "")
  base_path = local.trimmed == "" ? "/" : local.trimmed
  # The base path and everything under it; with the root base path, only core's four routes (the rest of the site
  # stays on its own backend).
  core_paths = ["/sync", "/v1", "/optout", "/optin"]
  paths      = local.base_path == "/" ? flatten([for p in local.core_paths : [p, "${p}/"]]) : [local.base_path, "${local.base_path}/*"]
}

data "archive_file" "source" {
  type        = "zip"
  source_dir  = "${path.module}/${var.source_dir}"
  output_path = "${path.module}/.build/sharedid-edge.zip"
  excludes    = ["node_modules"]
}

resource "google_storage_bucket" "source" {
  name                        = "${var.project}-${var.name}-source"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = true
}

resource "google_storage_bucket_object" "source" {
  name   = "sharedid-edge-${data.archive_file.source.output_md5}.zip"
  bucket = google_storage_bucket.source.name
  source = data.archive_file.source.output_path
}

resource "google_service_account" "function" {
  account_id   = var.name
  display_name = "SharedID Edge function"
}

resource "google_secret_manager_secret_iam_member" "module_secrets" {
  count     = var.sid_module_secrets_secret == "" ? 0 : 1
  secret_id = var.sid_module_secrets_secret
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.function.email}"
}

resource "google_cloudfunctions2_function" "sharedid_edge" {
  name     = var.name
  location = var.region

  build_config {
    runtime     = "nodejs24"
    entry_point = "sharedidEdge"
    source {
      storage_source {
        bucket = google_storage_bucket.source.name
        object = google_storage_bucket_object.source.name
      }
    }
  }

  service_config {
    min_instance_count    = var.min_instance_count
    max_instance_count    = var.max_instance_count
    available_memory      = "256M"
    timeout_seconds       = 10
    service_account_email = google_service_account.function.email
    # Only the load balancer (and the project's own network) can reach the function, so the X-Forwarded-For entries
    # and custom request headers it sees are the load balancer's.
    ingress_settings               = "ALLOW_INTERNAL_AND_GCLB"
    all_traffic_on_latest_revision = true
    environment_variables = {
      SID_BASE_PATH          = local.base_path
      SID_COOKIE_NAME        = var.sid_cookie_name
      SID_COOKIE_DOMAIN      = var.sid_cookie_domain
      SID_MAX_AGE_DAYS       = var.sid_max_age_days
      SID_CREATE             = var.sid_create
      SID_RECOVERY_COOKIE    = var.sid_recovery_cookie
      SID_OPTOUT_COOKIE      = var.sid_optout_cookie
      SID_VENDOR_ID          = var.sid_vendor_id
      SID_ALLOWED_ORIGINS    = var.sid_allowed_origins
      SID_SYNC_CACHE_SECONDS = var.sid_sync_cache_seconds
      SID_MODULES            = var.sid_modules
      SID_MODULE_CONFIG      = var.sid_module_config
      SID_MODULE_TIMEOUT_MS  = var.sid_module_timeout_ms
      SID_SYNC_MODULES       = var.sid_sync_modules
      SID_SKIP_BOTS          = var.sid_skip_bots
      SID_SKIP_BOTS_SCORE    = var.sid_skip_bots_score
      SID_TRUSTED_HOPS       = var.sid_trusted_hops
      SID_LOCATION_HEADERS   = var.location_headers ? jsonencode(local.location_headers) : ""
    }
    # The module secrets come from Secret Manager, resolved by the platform when an instance starts.
    dynamic "secret_environment_variables" {
      for_each = var.sid_module_secrets_secret == "" ? [] : [var.sid_module_secrets_secret]
      content {
        key        = "SID_MODULE_SECRETS"
        project_id = var.project
        secret     = secret_environment_variables.value
        version    = "latest"
      }
    }
  }

  depends_on = [google_secret_manager_secret_iam_member.module_secrets]
}

# The endpoint is public, like the site; ingress keeps everything but the load balancer out.
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  name     = google_cloudfunctions2_function.sharedid_edge.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_compute_region_network_endpoint_group" "sharedid_edge" {
  name                  = var.name
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = google_cloudfunctions2_function.sharedid_edge.name
  }
}

resource "google_compute_backend_service" "sharedid_edge" {
  name                  = var.name
  protocol              = "HTTPS"
  load_balancing_scheme = var.load_balancing_scheme
  # Responses carry per-visitor cookies: never cache them.
  enable_cdn             = false
  custom_request_headers = var.location_headers ? [for field, header in local.location_headers : "${header}: ${local.location_variables[field]}"] : []

  backend {
    group = google_compute_region_network_endpoint_group.sharedid_edge.id
  }
}
