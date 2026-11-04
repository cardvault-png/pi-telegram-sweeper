async function fetchAccount(baseUrl, publicKey) {
  const url = `${baseUrl}/accounts/${encodeURIComponent(publicKey)}`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Horizon HTTP ${response.status}: ${body.slice(0, 100)}`);
  }
  return response.json();
}
module.exports = { fetchAccount };
