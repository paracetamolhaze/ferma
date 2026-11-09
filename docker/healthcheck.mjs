try {
  const response = await fetch('http://localhost:3100/api/workspace', { signal: AbortSignal.timeout(4000) });
  const data = await response.json();
  process.exit(response.ok && Array.isArray(data.profiles) && Array.isArray(data.media) ? 0 : 1);
} catch {
  process.exit(1);
}
