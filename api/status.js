/**
 * Health Check Endpoint
 * 
 * Simple status endpoint to verify the service is running
 */

module.exports = async (req, res) => {
  return res.status(200).json({
    status: 'ok',
    service: 'AI Missed Call Recovery MVP',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'production',
    endpoints: {
      twilioWebhook: '/api/webhook',
      vapiWebhook: '/api/vapi-webhook',
      calcomOauth: '/api/calcom/oauth',
      dailyDigest: '/api/cron/daily-digest',
      status: '/api/status'
    }
  });
};
