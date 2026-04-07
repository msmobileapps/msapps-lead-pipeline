/**
 * Health check — verifies GCal OAuth connection + env vars.
 */
import { handleCors, jsonResponse } from './_lib/store.js'
import { checkHealth } from './_lib/gcal.js'

export default async (request) => {
  const cors = handleCors(request)
  if (cors) return cors

  try {
    const health = await checkHealth()
    return jsonResponse({
      ...health,
      service: 'msapps-lead-pipeline',
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    return jsonResponse({
      status: 'error',
      error: err.message,
      service: 'msapps-lead-pipeline',
      timestamp: new Date().toISOString(),
    }, 500)
  }
}

export const config = { path: '/api/health' }
