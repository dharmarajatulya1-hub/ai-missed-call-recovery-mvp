/**
 * Cal.com OAuth2 Handler
 * 
 * This endpoint handles BOTH:
 * 1. Initial redirect TO Cal.com (with business_id)
 * 2. Callback FROM Cal.com (with code and state)
 * 
 * Flow:
 * 1. Business visits: /api/calcom/oauth?business_id=xxx
 * 2. Redirected to Cal.com authorization page
 * 3. Cal.com redirects back with code
 * 4. Exchange code for access token
 * 5. Store credentials in database
 * 
 * URL: /api/calcom/oauth
 * Method: GET
 */

const { exchangeCodeForToken } = require('../../lib/calcom');
const { updateCalcomCredentials } = require('../../lib/supabase');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { code, state, business_id, error: oauthError, error_description } = req.query;

    // Handle OAuth errors from Cal.com
    if (oauthError) {
      console.error('❌ Cal.com OAuth error:', oauthError, error_description);
      return res.status(400).json({
        error: 'OAuth failed',
        message: error_description || oauthError
      });
    }

    // ============================================
    // STEP 1: Initial Request - Redirect TO Cal.com
    // ============================================
    if (!code && business_id) {
      console.log('🔐 Starting Cal.com OAuth for business:', business_id);

      // Validate environment variables
      const clientId = process.env.CALCOM_CLIENT_ID;
      const redirectUri = process.env.CALCOM_REDIRECT_URI;

      if (!clientId || !redirectUri) {
        console.error('❌ Missing Cal.com OAuth configuration');
        return res.status(500).json({
          error: 'Configuration error',
          message: 'Cal.com OAuth not configured. Check CALCOM_CLIENT_ID and CALCOM_REDIRECT_URI.'
        });
      }

      // Create state parameter (base64 encoded business_id)
      const stateData = JSON.stringify({ businessId: business_id });
      const encodedState = Buffer.from(stateData).toString('base64');

      // Build Cal.com authorization URL
      const authUrl = new URL('https://app.cal.com/auth/oauth2/authorize');
      authUrl.searchParams.append('client_id', clientId);
      authUrl.searchParams.append('redirect_uri', redirectUri);
      authUrl.searchParams.append('response_type', 'code');
      authUrl.searchParams.append('state', encodedState);
      // Optional: add scope if needed
      // authUrl.searchParams.append('scope', 'READ_BOOKING WRITE_BOOKING');

      console.log('🔄 Redirecting to Cal.com:', authUrl.toString());

      // Redirect user to Cal.com
      return res.redirect(authUrl.toString());
    }

    // ============================================
    // STEP 2: Callback - Handle redirect FROM Cal.com
    // ============================================
    if (!code || !state) {
      return res.status(400).json({
        error: 'Missing required parameters',
        message: 'This endpoint requires either:\n1. business_id (to start OAuth)\n2. code and state (OAuth callback)',
        example: '/api/calcom/oauth?business_id=your-business-uuid'
      });
    }

    // Decode state to get business ID
    let businessId;
    try {
      const stateData = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
      businessId = stateData.businessId;
    } catch (decodeError) {
      console.error('❌ Error decoding state:', decodeError);
      return res.status(400).json({
        error: 'Invalid state parameter',
        message: 'Could not decode business ID from state'
      });
    }

    if (!businessId) {
      return res.status(400).json({
        error: 'Missing business ID',
        message: 'State parameter did not contain business ID'
      });
    }

    console.log('🔐 Processing Cal.com OAuth callback for business:', businessId);

    // Exchange authorization code for access token
    const tokens = await exchangeCodeForToken(code);

    console.log('✅ Successfully obtained Cal.com access token');

    // Store credentials in database
    await updateCalcomCredentials(businessId, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at,
      event_type_id: null // Will be configured later
    });

    console.log('✅ Cal.com credentials stored successfully');

    // Return success response
    return res.status(200).json({
      success: true,
      message: 'Cal.com connected successfully!',
      businessId: businessId,
      next_steps: [
        'Set calcom_enabled = true in businesses table',
        'Configure your event type in Cal.com',
        'Test booking by calling your number'
      ]
    });

  } catch (error) {
    console.error('❌ Error in Cal.com OAuth:', error);

    return res.status(500).json({
      error: 'OAuth failed',
      message: error.message
    });
  }
};
