/** "Swagger Petstore" -> "swagger-petstore" (for package name) / "SWAGGER_PETSTORE" (for env vars) */
export function slugify(title: string): string {
  return title
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

export function envSlug(title: string): string {
  return slugify(title).replace(/-/g, "_").toUpperCase();
}
