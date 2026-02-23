export async function fetchWithProgress<T = unknown>(
  url: string,
  options?: RequestInit,
) {
  const response = await fetch(url, options);

  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }

  return response.json() as T;
}
