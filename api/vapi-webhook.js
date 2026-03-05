/**
 * VAPI Event Webhook Handler
 * 
 * Receives events from VAPI AI during and after calls.
 * Uses modular prompt and config builders for easy customization.
 * 
 * Configure this URL in your VAPI dashboard under "Server URL".
 * 
 * Events handled:
 * - assistant-request: When call starts (returns custom assistant config)
 * - status-update: Call status changes
 * - transcript: Real-time conversation
 * - function-call: AI function execution
 * - end-of-call-report: Final analytics
 * 
 * VAPI Webhook Docs: https://docs.vapi.ai/server-url
 */

const {
  getBusinessByPhone,
  upsertCall,
  insertTranscript,
  createBooking,
  getCalcomCredentials
} = require('../lib/supabase');

const {
  buildAssistantConfig,
  buildDefaultConfig,
  buildBookingConfig,
  ASSISTANT_TYPES
} = require('../lib/vapi');

// Transcript sequence tracking (in-memory, per-instance)
const transcriptSequences = new Map();

/**
 * Main webhook handler
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const event = req.body;
    const eventType = event.message?.type || 'unknown';

    console.log('🔔 VAPI Event:', {
      type: eventType,
      callId: event.message?.call?.id,
      timestamp: new Date().toISOString()
    });

    switch (eventType) {
      case 'assistant-request':
        return await handleAssistantRequest(event, res);
      
      case 'status-update':
        return await handleStatusUpdate(event, res);
      
      case 'transcript':
        return await handleTranscript(event, res);
      
      case 'function-call':
        return await handleFunctionCall(event, res);
      
      case 'end-of-call-report':
        return await handleEndOfCallReport(event, res);
      
      default:
        console.log('ℹ️ Unhandled event type:', eventType);
        return res.status(200).json({ received: true });
    }

  } catch (error) {
    console.error('❌ Webhook error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
};

// ============================================================
// EVENT HANDLERS
// ============================================================

/**
 * Handle assistant-request: Return dynamic assistant configuration
 */
async function handleAssistantRequest(event, res) {
  const { call } = event.message;
  const phoneNumber = getBusinessPhoneNumber(call);
  
  console.log('🤖 Assistant request for:', phoneNumber);

  try {
    // Look up business
    const business = await getBusinessByPhone(phoneNumber);
    
    if (!business) {
      console.warn('⚠️ Business not found:', phoneNumber);
      return res.status(200).json({
        assistant: buildDefaultConfig()
      });
    }

    console.log('✅ Found business:', business.name);

    // Create initial call record
    await upsertCall({
      business_id: business.id,
      vapi_call_id: call?.id,
      customer_phone: call?.customer?.number,
      from_phone: call?.customer?.number || 'unknown',
      to_phone: phoneNumber || 'unknown',
      status: 'queued',
      direction: 'inbound',
      metadata: { vapi_call: call }
    });

    // Check Cal.com integration
    const calcomIntegration = await getCalcomCredentials(business.id);
    const hasCalcom = !!(business.calcom_enabled && calcomIntegration?.access_token);

    // Build appropriate config
    let config;
    if (hasCalcom) {
      config = buildBookingConfig(business, calcomIntegration);
      console.log('✅ Booking config generated with Cal.com');
    } else {
      config = buildAssistantConfig(business, {
        type: ASSISTANT_TYPES.BASIC,
        enableBooking: false
      });
      console.log('✅ Basic config generated');
    }

    // Debug: Log the generated prompt (remove in production)
    console.log('📝 Generated prompt preview:', 
      config.model.messages[0].content.substring(0, 100) + '...'
    );

    return res.status(200).json({ assistant: config });

  } catch (error) {
    console.error('❌ Error building assistant config:', error);
    return res.status(200).json({
      assistant: buildDefaultConfig()
    });
  }
}

/**
 * Handle status-update: Track call lifecycle
 */
async function handleStatusUpdate(event, res) {
  const { call, status } = event.message;
  const phoneNumber = getBusinessPhoneNumber(call);

  console.log('📊 Status update:', { callId: call?.id, status });

  try {
    const business = await getBusinessByPhone(phoneNumber);
    if (!business) {
      return res.status(200).json({ received: true });
    }

    await upsertCall({
      business_id: business.id,
      vapi_call_id: call?.id,
      customer_phone: call?.customer?.number,
      from_phone: call?.customer?.number || 'unknown',
      to_phone: phoneNumber || 'unknown',
      status: mapVapiStatus(status),
      started_at: call?.startedAt ? new Date(call.startedAt).toISOString() : null,
      metadata: { vapi_status: status }
    });

  } catch (error) {
    console.error('❌ Error updating status:', error);
  }

  return res.status(200).json({ received: true });
}

/**
 * Handle transcript: Store conversation
 */
async function handleTranscript(event, res) {
  const { call, transcript, role } = event.message;
  const phoneNumber = getBusinessPhoneNumber(call);

  console.log('💬 Transcript:', { 
    callId: call?.id, 
    role,
    text: transcript?.substring(0, 50) + '...'
  });

  try {
    const business = await getBusinessByPhone(phoneNumber);
    if (!business) {
      return res.status(200).json({ received: true });
    }

    const callRecord = await upsertCall({
      business_id: business.id,
      vapi_call_id: call?.id,
      customer_phone: call?.customer?.number,
      from_phone: call?.customer?.number || 'unknown',
      to_phone: phoneNumber || 'unknown'
    });

    // Track sequence
    const callKey = call?.id;
    const sequence = (transcriptSequences.get(callKey) || 0) + 1;
    transcriptSequences.set(callKey, sequence);

    await insertTranscript(
      callRecord.id,
      role === 'user' ? 'user' : 'assistant',
      transcript,
      sequence
    );

  } catch (error) {
    console.error('❌ Error saving transcript:', error);
  }

  return res.status(200).json({ received: true });
}

/**
 * Handle function-call: Execute business logic
 */
async function handleFunctionCall(event, res) {
  const { call, functionCall } = event.message;
  const { name, parameters } = functionCall;
  const phoneNumber = getBusinessPhoneNumber(call);

  console.log('🔧 Function call:', { name, parameters });

  try {
    const business = await getBusinessByPhone(phoneNumber);
    if (!business) {
      return res.status(200).json({ error: 'Business not found' });
    }

    // Check if booking is enabled
    if ((name === 'checkAvailability' || name === 'createBooking') && !business.calcom_enabled) {
      return res.status(200).json({
        result: "Scheduling isn't available right now. Can I take a message for you?"
      });
    }

    // Verify Cal.com credentials
    const calcomIntegration = await getCalcomCredentials(business.id);
    if ((name === 'checkAvailability' || name === 'createBooking') && !calcomIntegration?.access_token) {
      return res.status(200).json({
        result: "Scheduling isn't available right now. Can I take a message for you?"
      });
    }

    // Route to handler
    switch (name) {
      case 'checkAvailability':
        return await handleCheckAvailability(business, parameters, res);
      
      case 'createBooking':
        return await handleCreateBooking(business, call, parameters, res);
      
      case 'scheduleCallback':
        return res.status(200).json({
          result: "I've noted your request for a callback. Someone will contact you soon."
        });
      
      default:
        return res.status(200).json({ error: `Unknown function: ${name}` });
    }

  } catch (error) {
    console.error('❌ Function error:', error);
    return res.status(200).json({ error: error.message });
  }
}

/**
 * Handle end-of-call-report: Finalize call data
 */
async function handleEndOfCallReport(event, res) {
  const { call, endedReason, summary, transcript, recording, analysis } = event.message;
  const phoneNumber = getBusinessPhoneNumber(call);

  console.log('📋 End of call:', { 
    callId: call?.id, 
    duration: call?.duration,
    reason: endedReason 
  });

  try {
    const business = await getBusinessByPhone(phoneNumber);
    if (!business) {
      return res.status(200).json({ received: true });
    }

    await upsertCall({
      business_id: business.id,
      vapi_call_id: call?.id,
      customer_phone: call?.customer?.number,
      from_phone: call?.customer?.number || 'unknown',
      to_phone: phoneNumber || 'unknown',
      status: 'completed',
      started_at: call?.startedAt ? new Date(call.startedAt).toISOString() : null,
      ended_at: call?.endedAt ? new Date(call.endedAt).toISOString() : null,
      duration_seconds: call?.duration || null,
      ended_reason: endedReason,
      recording_url: recording?.url,
      full_transcript: transcript,
      summary: summary,
      sentiment: analysis?.sentiment || null,
      intent: analysis?.intent || extractIntent(summary, transcript),
      metadata: {
        vapi_analysis: analysis,
        vapi_call: call
      }
    });

    // Cleanup
    transcriptSequences.delete(call?.id);

  } catch (error) {
    console.error('❌ Error saving end-of-call report:', error);
  }

  return res.status(200).json({ received: true });
}

// ============================================================
// BUSINESS LOGIC HANDLERS
// ============================================================

async function handleCheckAvailability(business, parameters, res) {
  const { date, timePreference } = parameters;
  
  console.log('📅 Checking availability:', { date, timePreference, business: business.name });

  try {
    const { checkAvailability } = require('../lib/calcom');
    const slots = await checkAvailability(business.id, date, timePreference);

    if (slots?.length > 0) {
      const formatted = slots.slice(0, 3).map(s => 
        new Date(s).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
      );

      return res.status(200).json({
        result: `I have availability at: ${formatted.join(', ')}. Which time works best for you?`,
        slots: slots
      });
    } else {
      return res.status(200).json({
        result: `I don't have any availability on ${date}. Would you like to try another date?`
      });
    }

  } catch (error) {
    console.error('❌ Availability check failed:', error);
    return res.status(200).json({
      error: 'Unable to check availability at this time'
    });
  }
}

async function handleCreateBooking(business, call, parameters, res) {
  const { name, email, phone, dateTime, notes } = parameters;
  
  console.log('✨ Creating booking:', { name, email, dateTime, business: business.name });

  try {
    const { createCalcomBooking } = require('../lib/calcom');
    
    const calcomBooking = await createCalcomBooking(business.id, {
      name,
      email,
      phone: phone || call?.customer?.number,
      start: dateTime,
      notes: notes || `Booked via AI assistant for ${business.name}`
    });

    // Get or create call record
    const callRecord = await upsertCall({
      business_id: business.id,
      vapi_call_id: call?.id,
      customer_phone: call?.customer?.number,
      from_phone: call?.customer?.number || 'unknown',
      to_phone: getBusinessPhoneNumber(call) || 'unknown'
    });

    // Get Cal.com integration for event type
    const calcomIntegration = await getCalcomCredentials(business.id);
    
    // Save booking to DB
    await createBooking({
      business_id: business.id,
      call_id: callRecord.id,
      calcom_booking_id: calcomBooking.id,
      calcom_uid: calcomBooking.uid,
      calcom_event_type_id: calcomIntegration?.config?.event_type_id || null,
      customer_name: name,
      customer_email: email,
      customer_phone: phone || call?.customer?.number,
      scheduled_at: new Date(dateTime).toISOString(),
      duration_minutes: 30,
      status: 'confirmed',
      notes: notes
    });

    const formattedTime = new Date(dateTime).toLocaleString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });

    return res.status(200).json({
      result: `Perfect! I've scheduled your appointment for ${formattedTime}. You'll receive a confirmation email at ${email}. Is there anything else I can help you with?`
    });

  } catch (error) {
    console.error('❌ Booking creation failed:', error);
    return res.status(200).json({
      error: 'Unable to create booking. Let me take a message for you.'
    });
  }
}

// ============================================================
// HELPERS
// ============================================================

function getBusinessPhoneNumber(call) {
  return (
    call?.phoneNumber?.number ||
    call?.phoneNumber?.twilioPhoneNumber ||
    call?.to?.number ||
    call?.to ||
    null
  );
}

function mapVapiStatus(vapiStatus) {
  const map = {
    'queued': 'queued',
    'ringing': 'ringing',
    'in-progress': 'in-progress',
    'forwarding': 'in-progress',
    'ended': 'completed'
  };
  return map[vapiStatus] || vapiStatus;
}

function extractIntent(summary, transcript) {
  const text = `${summary || ''} ${transcript || ''}`.toLowerCase();
  
  if (text.includes('appointment') || text.includes('schedule') || text.includes('book')) {
    return 'booking';
  }
  if (text.includes('question') || text.includes('information')) {
    return 'inquiry';
  }
  if (text.includes('problem') || text.includes('issue') || text.includes('complaint')) {
    return 'complaint';
  }
  if (text.includes('cancel') || text.includes('reschedule')) {
    return 'modification';
  }
  
  return 'general';
}
