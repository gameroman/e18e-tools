export async function fetchWithProgress<T = unknown>(
  url: string,
  options?: RequestInit,
) {
  const { ...fetchOptions } = options;

  let response = await fetch(url, fetchOptions);

  if (!response.ok) {
    throw new Error(`HTTP error! Status: ${response.status}`);
  }

  return response.json() as T;
}
