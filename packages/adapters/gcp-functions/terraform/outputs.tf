output "backend_service" {
  description = "The backend service for your URL map's path rule."
  value       = google_compute_backend_service.sharedid_edge.id
}

output "path_rule_paths" {
  description = "The paths for the path rule, from sid_base_path."
  value       = local.paths
}

output "function_uri" {
  description = "The function's own URL. It refuses requests that don't come through the load balancer."
  value       = google_cloudfunctions2_function.sharedid_edge.service_config[0].uri
}
