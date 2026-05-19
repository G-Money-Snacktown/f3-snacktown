// Netlify serverless function — proxies F3 Nation API requests
// Env vars: F3_BEARER_TOKEN, F3_REGION_ORG_ID

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const token = process.env.F3_BEARER_TOKEN;
  const regionOrgId = event.queryStringParameters?.regionOrgId || process.env.F3_REGION_ORG_ID || '25250';

  if (!token) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'F3_BEARER_TOKEN not configured in Netlify environment variables', events: [] }),
    };
  }

  const today = new Date().toISOString().split('T')[0];
  const apiUrl = `https://api.f3nation.com/v1/event-instance/calendar-home-schedule?regionOrgId=${regionOrgId}&userId=1&startDate=${today}&limit=150`;

  try {
    const resp = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'client': 'f3-snacktown',
      },
    });

    const text = await resp.text();

    if (!resp.ok) {
      // Return 200 so frontend JS can parse the error
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: `F3 Nation API returned ${resp.status}. Token may be invalid or expired. Check F3_BEARER_TOKEN in Netlify env vars.`,
          apiStatus: resp.status,
          apiResponse: text.slice(0, 300),
          events: [],
        }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Cache-Control': 'public, max-age=1800' },
      body: text,
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: `Fetch failed: ${err.message}`, events: [] }),
    };
  }
};
