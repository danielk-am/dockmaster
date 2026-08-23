export async function apiGet(path) {
  const response = await fetch(`/api/${path}`);
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status}).`);
  return body;
}
