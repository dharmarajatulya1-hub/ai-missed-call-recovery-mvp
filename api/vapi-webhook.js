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
 * - tool-calls: AI tool/function execution (current Vapi event)
 * - end-of-call-report: Final analytics
 * 
 * VAPI Webhook Docs: https://docs.vapi.ai/server-url
 */

const {
  getBusinessByPhone,
  upsertCall,
  insertTranscript,
  createBooking,
  getBookingByCall,
  insertBookingRequest,
  getBookingRequestByCall,
  getCalcomCredentials
} = require('../lib/supabase');

const {
  buildAssistantConfig,
  buildDefaultConfig,
  buildBookingConfig,
  ASSISTANT_TYPES
} = require('../lib/vapi');
const { APP_TIME_ZONE, getCurrentDateInTimeZone } = require('../lib/time');
const { sendEmail, escapeHtml } = require('../lib/email');
const { sendSMS } = require('../lib/twilio');

/**
 * Main webhook handler
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Authenticate the webhook. VAPI sends the per-assistant/server secret in
  // `x-vapi-secret`. Refuse to serve if the secret is unset (fail closed) or
  // the provided value does not match — forged events could otherwise create
  // real Cal.com bookings or inject text into the owner's digest.
  const providedSecret = req.headers['x-vapi-secret'];
  if (!process.env.VAPI_WEBHOOK_SECRET || providedSecret !== process.env.VAPI_WEBHOOK_SECRET) {
    console.warn('⚠️ Rejected VAPI webhook with missing/invalid x-vapi-secret');
    return res.status(401).json({ error: 'Unauthorized' });
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

      case 'tool-calls':
        return await handleToolCalls(event, res);
      
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
 * Check if this is a test call (should skip DB operations)
 */
function isTestCall(call) {
  const callId = call?.id || '';
  return callId.startsWith('test-') || callId.startsWith('debug-');
}

/**
 * Build a `calls` upsert payload with safe NOT NULL fallbacks.
 * `customer_phone`, `from_phone`, and `to_phone` are all NOT NULL in the
 * schema, so a withheld caller ID must still resolve to a value. Single source
 * of truth for the payload shape used by every webhook handler.
 */
function callRecordPayload(business, call, phoneNumber, extra = {}) {
  const caller = call?.customer?.number || 'unknown';
  return {
    business_id: business.id,
    vapi_call_id: call?.id,
    customer_phone: caller,
    from_phone: caller,
    to_phone: phoneNumber || getBusinessPhoneNumberQuiet(call) || 'unknown',
    ...extra
  };
}

/**
 * Handle assistant-request: Return dynamic assistant configuration
 */
async function handleAssistantRequest(event, res) {
  const { call } = event.message;
  
  const phoneNumber = getBusinessPhoneNumber(call, event.message);
  const testMode = isTestCall(call);
  
  console.log('🤖 Assistant request for phone:', phoneNumber, testMode ? '(TEST MODE - no DB write)' : '');

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

    // Persist the 'queued' call record. Awaited on purpose: in Vercel
    // serverless a fire-and-forget promise can be frozen after the response
    // returns, and for a call with no later events this is the only record —
    // losing it means a missed call vanishes from the dashboard/digest.
    if (!testMode) {
      await upsertCall(callRecordPayload(business, call, phoneNumber, {
        status: 'queued',
        direction: 'inbound',
        metadata: { vapi_call: call }
      }));
    } else {
      console.log('🧪 Test call - skipping DB insert');
    }

    // Check Cal.com integration
    const calcomIntegration = await getCalcomCredentials(business.id);
    const hasCalcomToken = !!(business.calcom_enabled && calcomIntegration?.access_token);

    // Resolve the booking mode. Driven by business.booking_mode, with two guards:
    // an explicit appointment_handling_enabled=false always wins (owner opted
    // out); 'live' requires a valid Cal.com token else it degrades to capture.
    let bookingMode = business.booking_mode || 'capture';
    if (business.appointment_handling_enabled === false) {
      bookingMode = 'none';
    } else if (bookingMode === 'live' && !hasCalcomToken) {
      console.warn(`⚠️ booking_mode=live but no Cal.com token for ${business.id}; degrading to capture`);
      bookingMode = 'capture';
    }

    // Voice preset resolves in getVoiceConfig: ai_config.voice_preset →
    // ai_voice_preset column → default (Sarah). Not hardcoded here.
    const voiceOptions = {
      appointmentHandlingEnabled: business.appointment_handling_enabled
    };

    let config;
    if (bookingMode === 'live') {
      config = buildBookingConfig(business, calcomIntegration, voiceOptions);
      console.log('✅ Live booking config (Cal.com) generated');
    } else if (bookingMode === 'capture') {
      config = buildAssistantConfig(business, {
        type: ASSISTANT_TYPES.BASIC,
        enableBooking: false,
        enableCapture: true,
        ...voiceOptions
      });
      console.log('✅ Capture-and-confirm config generated');
    } else if (bookingMode === 'callback') {
      config = buildAssistantConfig(business, {
        type: ASSISTANT_TYPES.BASIC,
        enableBooking: false,
        enableCallback: true,
        ...voiceOptions
      });
      console.log('✅ Callback config generated');
    } else {
      config = buildAssistantConfig(business, {
        type: ASSISTANT_TYPES.BASIC,
        enableBooking: false,
        ...voiceOptions
      });
      console.log('✅ Basic (no scheduling) config generated');
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
  const phoneNumber = getBusinessPhoneNumber(call, event.message);
  const testMode = isTestCall(call);

  console.log('📊 Status update:', { callId: call?.id, status, testMode });

  try {
    const business = await getBusinessByPhone(phoneNumber);
    if (!business) {
      return res.status(200).json({ received: true });
    }

    if (testMode) {
      console.log('🧪 Test call - skipping DB update');
      return res.status(200).json({ received: true });
    }

    await upsertCall(callRecordPayload(business, call, phoneNumber, {
      status: mapVapiStatus(status),
      started_at: call?.startedAt ? new Date(call.startedAt).toISOString() : null,
      metadata: { vapi_status: status }
    }));

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
  const phoneNumber = getBusinessPhoneNumber(call, event.message);
  const testMode = isTestCall(call);

  console.log('💬 Transcript:', { 
    callId: call?.id, 
    role,
    text: transcript?.substring(0, 50) + '...',
    testMode
  });

  try {
    const business = await getBusinessByPhone(phoneNumber);
    if (!business) {
      return res.status(200).json({ received: true });
    }

    if (testMode) {
      console.log('🧪 Test call - skipping DB insert');
      return res.status(200).json({ received: true });
    }

    const callRecord = await upsertCall(callRecordPayload(business, call, phoneNumber));

    // No in-memory sequence counter: it reset per lambda instance and caused
    // duplicate sequence numbers → unique-constraint collisions → dropped
    // lines. Persist with a NULL sequence (the unique index tolerates NULLs)
    // and reconstruct order from spoken_at.
    await insertTranscript(
      callRecord.id,
      role === 'user' ? 'user' : 'assistant',
      transcript,
      null
    );

  } catch (error) {
    console.error('❌ Error saving transcript:', error);
  }

  return res.status(200).json({ received: true });
}

/**
 * Execute booking/callback logic for a single tool or function call
 */
async function executeFunctionCall(call, message, name, parameters) {
  const phoneNumber = getBusinessPhoneNumber(call, message);
  const business = await getBusinessByPhone(phoneNumber);

  if (!business) {
    console.error('❌ Business not found for phone:', phoneNumber);
    return {
      error: 'Business not configured',
      result: "I can't access the booking system right now. Let me take a message."
    };
  }

  console.log('✅ Business found:', business.name);

  if (name === 'checkAvailability' || name === 'createBooking') {
    if (!business.calcom_enabled) {
      console.log('⚠️ calcom_enabled is false');
      return {
        result: "Scheduling isn't available right now. Can I take a message for you?"
      };
    }

    const calcomIntegration = await getCalcomCredentials(business.id);
    if (!calcomIntegration?.access_token) {
      console.log('⚠️ No Cal.com access token');
      return {
        result: "Scheduling isn't available right now. Can I take a message for you?"
      };
    }

    console.log('✅ Cal.com ready');
  }

  switch (name) {
    case 'checkAvailability':
      return await handleCheckAvailability(business, parameters);

    case 'createBooking':
      return await handleCreateBooking(business, call, parameters);

    case 'captureBookingRequest':
      return await handleCaptureBookingRequest(business, call, parameters);

    case 'scheduleCallback':
      return await handleScheduleCallback(business, call, parameters);

    default:
      console.warn('⚠️ Unknown function:', name);
      return {
        error: `Function ${name} not implemented`,
        result: "I can't perform that action."
      };
  }
}

/**
 * Handle function-call: backward-compatible execution path
 */
async function handleFunctionCall(event, res) {
  const { call, functionCall } = event.message;
  const { name, parameters } = functionCall;
  const callId = call?.id;

  console.log('🔧 FUNCTION CALL:', { callId, name, timestamp: new Date().toISOString() });

  try {
    const payload = await executeFunctionCall(call, event.message, name, parameters);
    return res.status(200).json(payload);
  } catch (error) {
    console.error('❌ Function call error:', error);
    return res.status(200).json({
      error: error.message,
      result: "I encountered an error. Let me take a message."
    });
  }
}

function getToolCallName(toolCall) {
  return toolCall?.name
    || toolCall?.function?.name
    || toolCall?.tool?.name
    || toolCall?.tool?.function?.name
    || toolCall?.toolCall?.name
    || toolCall?.toolCall?.function?.name;
}

function getToolCallParameters(toolCall) {
  const rawParameters = toolCall?.parameters
    || toolCall?.arguments
    || toolCall?.function?.arguments
    || toolCall?.function?.parameters
    || toolCall?.tool?.arguments
    || toolCall?.tool?.parameters
    || toolCall?.tool?.function?.arguments
    || toolCall?.tool?.function?.parameters
    || toolCall?.toolCall?.arguments
    || toolCall?.toolCall?.parameters
    || toolCall?.toolCall?.function?.arguments
    || toolCall?.toolCall?.function?.parameters
    || {};

  if (typeof rawParameters !== 'string') {
    return rawParameters;
  }

  try {
    return JSON.parse(rawParameters);
  } catch (error) {
    console.warn('⚠️ Failed to parse tool-call arguments as JSON:', rawParameters);
    return {};
  }
}

/**
 * Handle tool-calls: current Vapi execution path
 */
async function handleToolCalls(event, res) {
  const { call, toolCallList = [] } = event.message;
  const toolNames = toolCallList.map(getToolCallName);

  console.log('🛠️ TOOL CALLS:', {
    callId: call?.id,
    count: toolCallList.length,
    toolNames,
    timestamp: new Date().toISOString()
  });

  if (process.env.NODE_ENV !== 'production') {
    console.log('🧾 RAW TOOL CALL PAYLOAD:', JSON.stringify(toolCallList));
  }

  try {
    const results = [];

    for (const toolCall of toolCallList) {
      const name = getToolCallName(toolCall);
      const parameters = getToolCallParameters(toolCall);

      const payload = await executeFunctionCall(call, event.message, name, parameters);
      results.push({
        name,
        toolCallId: toolCall.id,
        result: payload.result || payload.error || JSON.stringify(payload)
      });
    }

    return res.status(200).json({ results });
  } catch (error) {
    console.error('❌ Tool call error:', error);
    return res.status(200).json({
      results: toolCallList.map(toolCall => ({
        name: getToolCallName(toolCall),
        toolCallId: toolCall.id,
        result: "I encountered an error. Let me take a message."
      }))
    });
  }
}

/**
 * Handle end-of-call-report: Finalize call data
 */
async function handleEndOfCallReport(event, res) {
  const { call, endedReason, summary, transcript, recording, analysis } = event.message;
  const phoneNumber = getBusinessPhoneNumber(call, event.message);
  const testMode = isTestCall(call);

  console.log('📋 End of call:', { 
    callId: call?.id, 
    duration: call?.duration,
    reason: endedReason,
    testMode
  });

  try {
    const business = await getBusinessByPhone(phoneNumber);
    if (!business) {
      return res.status(200).json({ received: true });
    }

    if (testMode) {
      console.log('🧪 Test call - skipping DB update');
      return res.status(200).json({ received: true });
    }

    // VAPI puts analysisPlan output under analysis.structuredData.
    const structured = analysis?.structuredData || {};
    const sentiment = structured.sentiment || analysis?.sentiment || null;
    const intent = structured.intent || analysis?.intent || extractIntent(summary, transcript);

    const callRecord = await upsertCall(callRecordPayload(business, call, phoneNumber, {
      status: 'completed',
      started_at: call?.startedAt ? new Date(call.startedAt).toISOString() : null,
      ended_at: call?.endedAt ? new Date(call.endedAt).toISOString() : null,
      duration_seconds: call?.duration || null,
      ended_reason: endedReason,
      recording_url: recording?.url,
      full_transcript: transcript,
      summary: summary,
      sentiment,
      intent,
      metadata: {
        vapi_analysis: analysis,
        vapi_call: call
      }
    }));

    // Fire per-call reports (email default, SMS opt-in). Never let a report
    // failure fail the webhook — that would trigger VAPI retry storms.
    try {
      const bookingRequest = await getBookingRequestByCall(callRecord?.id);
      await sendCallReports({ business, call, summary, intent, bookingRequest });
    } catch (reportError) {
      console.error('❌ Per-call report failed (continuing):', reportError.message);
    }

  } catch (error) {
    console.error('❌ Error saving end-of-call report:', error);
  }

  return res.status(200).json({ received: true });
}

/**
 * Send per-call reports to the business owner: email (on by default) and SMS
 * (opt-in paid add-on). Each channel is best-effort and isolated.
 */
async function sendCallReports({ business, call, summary, intent, bookingRequest }) {
  const caller = call?.customer?.number || 'unknown';
  const durationSeconds = call?.duration || 0;
  const durationLabel = durationSeconds
    ? `${Math.floor(durationSeconds / 60)}m ${durationSeconds % 60}s`
    : 'n/a';
  const summaryText = summary || 'No summary available.';

  const bookingLines = bookingRequest
    ? [
        `Service: ${bookingRequest.service}`,
        `Preferred times: ${(bookingRequest.preferred_times || []).join('; ') || 'none given'}`,
        `Name: ${bookingRequest.customer_name}`,
        `Callback: ${bookingRequest.customer_phone}`
      ]
    : null;

  // ---- Email (default on) ----
  if (business.call_summary_email_enabled !== false && business.email) {
    try {
      await sendEmail(buildCallSummaryEmail({
        business, caller, durationLabel, intent, summaryText, bookingLines
      }));
    } catch (err) {
      console.error('❌ Per-call email failed:', err.message);
    }
  }

  // ---- SMS (opt-in) ----
  if (business.sms_report_enabled && business.owner_notification_phone) {
    try {
      const smsLines = [
        `${business.name}: call from ${caller}`,
        `Intent: ${intent}`,
        summaryText.slice(0, 160)
      ];
      if (bookingLines) {
        smsLines.push(`Request — ${bookingRequest.service}, ${(bookingRequest.preferred_times || []).join('; ')}, ${bookingRequest.customer_phone}`);
      }
      await sendSMS(business.owner_notification_phone, smsLines.join('\n'));
    } catch (err) {
      console.error('❌ Per-call SMS failed:', err.message);
    }
  }
}

/**
 * Build the per-call summary email payload.
 */
function buildCallSummaryEmail({ business, caller, durationLabel, intent, summaryText, bookingLines }) {
  const dashboardLink = process.env.DASHBOARD_URL || '';
  const subject = `New call — ${business.name} (${caller})`;

  const bookingBlockText = bookingLines
    ? `\n\nBOOKING REQUEST:\n${bookingLines.join('\n')}`
    : '';

  const text = [
    `New call for ${business.name}`,
    `Caller: ${caller}`,
    `Duration: ${durationLabel}`,
    `Intent: ${intent}`,
    '',
    'Summary:',
    summaryText,
    bookingBlockText,
    dashboardLink ? `\nDashboard: ${dashboardLink}` : ''
  ].filter(Boolean).join('\n');

  const bookingBlockHtml = bookingLines
    ? `
      <div style="background:#eef6ff;border:1px solid #cfe3ff;padding:12px;border-radius:8px;margin-top:16px;">
        <div style="font-weight:700;margin-bottom:6px;">Booking request</div>
        ${bookingLines.map((l) => `<div>${escapeHtml(l)}</div>`).join('')}
      </div>`
    : '';

  const html = `
    <div style="font-family: Arial, sans-serif; color:#111; line-height:1.5;">
      <h2 style="margin-bottom:4px;">New call</h2>
      <p style="margin:0;"><strong>${escapeHtml(business.name)}</strong></p>
      <table style="margin-top:12px;font-size:14px;">
        <tr><td style="padding:2px 12px 2px 0;color:#666;">Caller</td><td>${escapeHtml(caller)}</td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#666;">Duration</td><td>${escapeHtml(durationLabel)}</td></tr>
        <tr><td style="padding:2px 12px 2px 0;color:#666;">Intent</td><td>${escapeHtml(intent)}</td></tr>
      </table>
      <h3 style="margin:16px 0 4px;">Summary</h3>
      <p style="margin:0;">${escapeHtml(summaryText)}</p>
      ${bookingBlockHtml}
      ${dashboardLink ? `<p style="margin-top:16px;"><a href="${dashboardLink}">Open dashboard</a></p>` : ''}
    </div>
  `;

  return { to: business.email, subject, html, text };
}

// ============================================================
// BUSINESS LOGIC HANDLERS
// ============================================================

async function handleCheckAvailability(business, parameters) {
  const { date, timePreference } = parameters;
  
  console.log('📅 Checking availability:', { date, timePreference, business: business.name });

  const businessTimezone = business?.timezone || APP_TIME_ZONE;
  const todayInBusinessTimezone = getCurrentDateInTimeZone(businessTimezone);

  if (!date || date < todayInBusinessTimezone) {
    console.warn('⚠️ Rejecting past availability date:', {
      requestedDate: date,
      todayInBusinessTimezone,
      businessTimezone
    });

    return {
      error: 'Past date requested',
      result: `That date is in the past. Please ask for a date on or after ${todayInBusinessTimezone}.`
    };
  }

  try {
    const { checkAvailability } = require('../lib/calcom');
    const slots = await checkAvailability(business.id, date, timePreference);

    if (slots?.length > 0) {
      const slotOptions = slots.slice(0, 3).map(slot => ({
        iso: slot,
        display: new Date(slot).toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZone: businessTimezone
        })
      }));
      const formatted = slotOptions.map(slot => slot.display);

      return {
        result: `I have availability at: ${formatted.join(', ')}. Which time works best for you?`,
        slots: slots,
        slotOptions
      };
    } else {
      return {
        result: `I don't have any availability on ${date}. Would you like to try another date?`
      };
    }

  } catch (error) {
    console.error('❌ Availability check failed:', error);
    return {
      error: 'Unable to check availability at this time'
    };
  }
}

async function handleCreateBooking(business, call, parameters) {
  const { name, email, phone, dateTime, notes } = parameters;
  
  console.log('🔧 CREATE BOOKING CALLED:', {
    callId: call?.id,
    businessId: business.id,
    calcomEnabled: business.calcom_enabled,
    hasDateTime: !!dateTime,
    timestamp: new Date().toISOString()
  });

  const businessTimezone = business?.timezone || APP_TIME_ZONE;
  const formatTime = (iso) => new Date(iso).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: businessTimezone
  });

  try {
    // Idempotency pre-check (best-effort): a webhook redelivery or double model
    // call must not create a second real Cal.com appointment. This runs BEFORE
    // the Cal.com call, but a DB failure here must NOT abort an otherwise-healthy
    // booking — so it is isolated and we proceed even if it throws.
    let callRecord = null;
    try {
      callRecord = await upsertCall(callRecordPayload(business, call, null));
      const existingBooking = await getBookingByCall(callRecord?.id);
      if (existingBooking) {
        console.log('↩️ Booking already exists for this call; skipping duplicate:', existingBooking.id);
        return {
          result: `You're all set — I already have your appointment booked for ${formatTime(existingBooking.scheduled_at)}. Is there anything else I can help you with?`
        };
      }
    } catch (preCheckError) {
      console.error('⚠️ Booking idempotency pre-check failed; proceeding with Cal.com:', preCheckError.message);
    }

    const { createCalcomBooking } = require('../lib/calcom');

    console.log('📡 Calling Cal.com API...');

    const calcomBooking = await createCalcomBooking(business.id, {
      name,
      email,
      phone: phone || call?.customer?.number,
      start: dateTime,
      notes: notes || `Booked via AI assistant for ${business.name}`
    });
    const scheduledAt = calcomBooking?.start || calcomBooking?.startTime || new Date(dateTime).toISOString();

    console.log('✅ BOOKING CREATED SUCCESSFULLY:', {
      bookingId: calcomBooking?.id,
      bookingUid: calcomBooking?.uid,
      startTime: scheduledAt
    });

    const formattedTime = formatTime(scheduledAt);

    try {
      // Re-resolve the call record if the pre-check failed to produce one.
      if (!callRecord) {
        callRecord = await upsertCall(callRecordPayload(business, call, null));
      }
      const calcomIntegration = await getCalcomCredentials(business.id);

      await createBooking({
        business_id: business.id,
        call_id: callRecord.id,
        calcom_booking_id: calcomBooking.id,
        calcom_uid: calcomBooking.uid,
        calcom_event_type_id: calcomIntegration?.config?.event_type_id || null,
        customer_name: name,
        customer_email: email,
        customer_phone: phone || call?.customer?.number,
        scheduled_at: scheduledAt,
        duration_minutes: calcomBooking?.lengthInMinutes || calcomBooking?.duration || 30,
        status: 'confirmed',
        notes: notes
      });
    } catch (persistenceError) {
      // A unique violation (23505) means another delivery already recorded this
      // call's booking — treat as already-booked, not a hard failure.
      if (persistenceError.code === '23505') {
        console.warn('↩️ Duplicate booking persistence ignored (already recorded):', callRecord.id);
      } else {
        console.error('⚠️ Booking saved in Cal.com but local persistence failed:', {
          error: persistenceError.message,
          bookingUid: calcomBooking?.uid,
          business: business.name
        });
      }
    }

    return {
      result: `Perfect! I've scheduled your appointment for ${formattedTime}. You'll receive a confirmation email at ${email}. Is there anything else I can help you with?`
    };

  } catch (error) {
    console.error('❌ BOOKING CREATION FAILED:', {
      error: error.message,
      stack: error.stack,
      response: error.response?.data,
      status: error.response?.status,
      business: business.name,
      timestamp: new Date().toISOString()
    });
    
    return {
      error: `Booking failed: ${error.message}`,
      result: "I wasn't able to complete the booking. Let me take a message and have someone follow up with you."
    };
  }
}

/**
 * Persist a capture-and-confirm booking request (no live availability lookup).
 */
async function handleCaptureBookingRequest(business, call, parameters) {
  const { name, phone, email, service, preferredTimes, notes } = parameters;

  console.log('📝 CAPTURE BOOKING REQUEST:', {
    callId: call?.id,
    businessId: business.id,
    hasPreferredTimes: Array.isArray(preferredTimes) ? preferredTimes.length : 0,
    timestamp: new Date().toISOString()
  });

  const callbackPhone = phone || call?.customer?.number || 'unknown';
  const preferred = Array.isArray(preferredTimes)
    ? preferredTimes
    : (preferredTimes ? [String(preferredTimes)] : []);

  try {
    const callRecord = await upsertCall(callRecordPayload(business, call, null));

    await insertBookingRequest({
      business_id: business.id,
      call_id: callRecord.id,
      customer_name: name || 'Unknown caller',
      customer_phone: callbackPhone,
      customer_email: email || null,
      service: service || 'appointment',
      preferred_times: preferred,
      notes: notes || null,
      status: 'new'
    });

    return {
      result: "Got it — I've passed your request to the team; they'll call you back to confirm the exact time. Is there anything else I can help you with?"
    };
  } catch (error) {
    console.error('❌ Failed to capture booking request:', error.message);
    return {
      error: 'Unable to save booking request',
      result: "I had trouble saving that just now. Let me make sure the team follows up — can you confirm the best number to reach you?"
    };
  }
}

/**
 * Persist a callback request. Folded into booking_requests as a
 * service='callback' row so nothing is silently dropped.
 */
async function handleScheduleCallback(business, call, parameters) {
  const { preferredTime, reason } = parameters;

  console.log('📞 SCHEDULE CALLBACK:', {
    callId: call?.id,
    businessId: business.id,
    timestamp: new Date().toISOString()
  });

  try {
    const callRecord = await upsertCall(callRecordPayload(business, call, null));

    await insertBookingRequest({
      business_id: business.id,
      call_id: callRecord.id,
      customer_name: 'Unknown caller',
      customer_phone: call?.customer?.number || 'unknown',
      customer_email: null,
      service: 'callback',
      preferred_times: preferredTime ? [String(preferredTime)] : [],
      notes: reason || null,
      status: 'new'
    });

    return {
      result: "I've noted your request for a callback. Someone from the team will contact you soon."
    };
  } catch (error) {
    // Do NOT claim success on failure — that re-introduces the exact
    // "callback persists nothing" landmine. Be honest and reconfirm.
    console.error('❌ Failed to persist callback request:', error.message);
    return {
      error: 'Unable to save callback request',
      result: "I had trouble noting that just now — could you confirm the best number for the team to reach you?"
    };
  }
}

// ============================================================
// HELPERS
// ============================================================

function getBusinessPhoneNumber(call, message = null) {
  // VAPI sends phone number in different locations depending on configuration
  const possibleNumbers = [
    message?.phoneNumber?.number,           // New VAPI format (message level)
    message?.phoneNumber?.twilioPhoneNumber,
    call?.phoneNumber?.twilioPhoneNumber,   // Old formats (call level)
    call?.phoneNumber?.number,
    call?.to?.number,
    call?.to,
  ];
  
  // Find first valid phone number (starts with +)
  for (const num of possibleNumbers) {
    if (num && typeof num === 'string' && num.startsWith('+')) {
      return num;
    }
  }
  
  console.warn('⚠️ Could not extract phone number from VAPI payload');
  return null;
}

function getBusinessPhoneNumberQuiet(call, message = null) {
  const possibleNumbers = [
    message?.phoneNumber?.number,
    message?.phoneNumber?.twilioPhoneNumber,
    call?.phoneNumber?.twilioPhoneNumber,
    call?.phoneNumber?.number,
    call?.to?.number,
    call?.to,
  ];

  for (const num of possibleNumbers) {
    if (num && typeof num === 'string' && num.startsWith('+')) {
      return num;
    }
  }

  return null;
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
