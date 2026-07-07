/**
 * Twilio Voice Webhook Handler with Vapi AI Integration
 * 
 * This endpoint receives incoming voice calls from Twilio and forwards them to Vapi AI.
 * Configure this URL as your Twilio phone number's voice webhook.
 * 
 * Flow:
 * 1. Twilio receives call → POST to this webhook
 * 2. We call Vapi's /call endpoint with phoneCallProviderBypassEnabled: true
 * 3. Vapi returns TwiML that connects the call to their AI assistant
 * 4. We return that TwiML to Twilio
 * 5. Vapi handles the entire AI conversation
 * 6. Call events are sent to /api/vapi-webhook
 * 
 * Based on: https://github.com/VapiAI/example-phone-call-provider-bypass
 */

const twilio = require('twilio');

/**
 * Main webhook handler for incoming Twilio voice calls
 * Forwards call to Vapi AI assistant
 * 
 * @param {Request} req - Vercel request object
 * @param {Response} res - Vercel response object
 */
module.exports = async (req, res) => {
  // Only accept POST requests from Twilio
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Validate the request is from Twilio. Fail closed: without a valid
    // signature a forged request would trigger billed VAPI /call requests.
    const twilioSignature = req.headers['x-twilio-signature'];
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!authToken) {
      // Misconfiguration — refuse to serve rather than skip validation.
      console.error('❌ TWILIO_AUTH_TOKEN not configured; refusing request');
      return res.status(500).json({ error: 'Server misconfiguration' });
    }

    const url = `https://${req.headers.host}${req.url}`;
    const isValid = twilioSignature && twilio.validateRequest(
      authToken,
      twilioSignature,
      url,
      req.body
    );

    if (!isValid) {
      console.error('❌ Invalid or missing Twilio signature');
      return res.status(403).json({ error: 'Invalid signature' });
    }

    // Extract call details from Twilio webhook payload
    const {
      CallSid,
      From,
      To,
      CallStatus,
      Direction,
      CallerCity,
      CallerState,
      CallerCountry
    } = req.body;

    // Log incoming call details
    console.log('📞 Incoming call:', {
      callSid: CallSid,
      from: From,
      to: To,
      status: CallStatus,
      direction: Direction,
      location: `${CallerCity}, ${CallerState}, ${CallerCountry}`,
      timestamp: new Date().toISOString()
    });

    // Check Vapi configuration
    const vapiApiKey = process.env.VAPI_API_KEY;
    const vapiPhoneNumberId = process.env.VAPI_PHONE_NUMBER_ID;
    const vapiAssistantId = process.env.VAPI_ASSISTANT_ID;
    const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN;
    
    console.log('🔧 Env vars check:', {
      hasVapiKey: !!vapiApiKey,
      hasAssistantId: !!vapiAssistantId,
      hasPhoneNumberId: !!vapiPhoneNumberId,
      hasTwilioSid: !!twilioAccountSid,
      hasTwilioToken: !!twilioAuthToken
    });
    
    if (!vapiApiKey) {
      console.error('❌ VAPI_API_KEY not configured');
      return sendErrorResponse(res, 'Service configuration error. Please contact support.');
    }
    
    if (!vapiAssistantId) {
      console.error('❌ VAPI_ASSISTANT_ID not configured');
      return sendErrorResponse(res, 'Service configuration error. Please contact support.');
    }

    // Call Vapi to get TwiML for this call
    console.log('🤖 Requesting Vapi AI TwiML...');
    
    const vapiCallResponse = await fetch('https://api.vapi.ai/call', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${vapiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        // Phone number ID from Vapi dashboard (if you imported Twilio number to Vapi)
        // OR pass the raw phone number below
        phoneNumberId: vapiPhoneNumberId || undefined,
        
        // If no phoneNumberId, pass the Twilio number as object
        phoneNumber: vapiPhoneNumberId ? undefined : {
          twilioAccountSid: twilioAccountSid,
          twilioAuthToken: twilioAuthToken,
          twilioPhoneNumber: To
        },
        
        // This tells Vapi to return TwiML instead of initiating the call itself
        phoneCallProviderBypassEnabled: true,
        
        // Customer information
        customer: {
          number: From
        },
        
        // Assistant ID (required)
        assistantId: vapiAssistantId,
        
        // Optional: Add metadata for tracking
        metadata: {
          twilioCallSid: CallSid,
          twilioNumber: To,
          callerLocation: `${CallerCity}, ${CallerState}`,
          timestamp: new Date().toISOString()
        }
      })
    });

    if (!vapiCallResponse.ok) {
      const errorText = await vapiCallResponse.text();
      console.error('❌ Vapi API error:', vapiCallResponse.status, errorText);
      return sendErrorResponse(res, 'AI service temporarily unavailable. Please try again.');
    }

    const vapiCall = await vapiCallResponse.json();
    console.log('✅ Vapi call created:', vapiCall.id);

    // Extract TwiML from Vapi response
    const twiml = vapiCall.phoneCallProviderDetails?.twiml;

    if (!twiml) {
      console.error('❌ No TwiML in Vapi response:', vapiCall);
      return sendErrorResponse(res, 'AI service error. Please try again.');
    }

    // Return Vapi's TwiML to Twilio
    // This TwiML contains the WebSocket connection to Vapi's AI assistant
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send(twiml);

  } catch (error) {
    console.error('❌ Error handling webhook:', error);
    return sendErrorResponse(res, 'We are experiencing technical difficulties. Please try again later.');
  }
};

/**
 * Helper function to send error TwiML response
 * @param {Response} res - Vercel response object
 * @param {string} message - Error message to speak
 */
function sendErrorResponse(res, message) {
  const errorTwiml = new twilio.twiml.VoiceResponse();
  errorTwiml.say({
    voice: 'Polly.Joanna'
  }, message);
  errorTwiml.hangup();
  
  res.setHeader('Content-Type', 'text/xml');
  return res.status(200).send(errorTwiml.toString());
}
