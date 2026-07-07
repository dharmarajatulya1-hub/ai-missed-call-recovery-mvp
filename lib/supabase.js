/**
 * Supabase Client for Multi-tenant Database Access
 * 
 * This module provides a configured Supabase client with proper
 * authentication and row-level security (RLS) support.
 * 
 * Environment variables required:
 * - SUPABASE_URL: Your Supabase project URL
 * - SUPABASE_SERVICE_KEY: Service role key (bypasses RLS for server operations)
 * - SUPABASE_ANON_KEY: Anonymous key (for client-side if needed)
 */

const { createClient } = require('@supabase/supabase-js');

// Validate environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL) {
  throw new Error('Missing SUPABASE_URL environment variable');
}

if (!SUPABASE_SERVICE_KEY) {
  console.warn('⚠️ SUPABASE_SERVICE_KEY not set - server operations may fail');
}

/**
 * Service client - bypasses RLS, use for server-side operations
 * This should be used in webhook handlers and background jobs
 */
const supabaseService = SUPABASE_SERVICE_KEY 
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })
  : null;

/**
 * Anonymous client - respects RLS, use for client-facing operations
 * This should be used when you have a business_id in the JWT
 */
const supabaseAnon = SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

/**
 * Get business by phone number (for webhook lookups)
 * @param {string} phoneNumber - Phone number to lookup (E.164 format recommended)
 * @returns {Promise<Object|null>} Business object or null
 */
async function getBusinessByPhone(phoneNumber) {
  if (!supabaseService) throw new Error('Supabase service client not initialized');
  
  // Look up business via business_phone_numbers table
  const { data, error } = await supabaseService
    .from('business_phone_numbers')
    .select(`
      business_id,
      phone_number,
      label,
      businesses (
        id,
        name,
        email,
        timezone,
        business_hours,
        vapi_assistant_id,
        vapi_phone_number_id,
        calcom_enabled,
        booking_mode,
        appointment_handling_enabled,
        call_summary_email_enabled,
        sms_report_enabled,
        owner_notification_phone,
        digest_enabled,
        digest_time_local,
        digest_timezone,
        ai_instructions,
        services,
        specialties,
        faq_data,
        custom_greeting,
        custom_closing,
        ai_voice_preset,
        ai_config,
        active
      )
    `)
    .eq('phone_number', phoneNumber)
    .eq('active', true)
    .single();

  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
    console.error('Error fetching business:', error);
    return null;
  }

  // Return the business object from the join
  return data?.businesses || null;
}

/**
 * Get business by ID
 * @param {string} businessId - UUID of the business
 * @returns {Promise<Object|null>} Business object or null
 */
async function getBusinessById(businessId) {
  if (!supabaseService) throw new Error('Supabase service client not initialized');

  const { data, error } = await supabaseService
    .from('businesses')
    .select('id, name, email, timezone, calcom_enabled, appointment_handling_enabled, active')
    .eq('id', businessId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching business by ID:', error);
    return null;
  }

  return data;
}

/**
 * Create or update a call record
 * @param {Object} callData - Call data object
 * @returns {Promise<Object>} Created/updated call record
 */
async function upsertCall(callData) {
  if (!supabaseService) throw new Error('Supabase service client not initialized');
  
  const { data, error } = await supabaseService
    .from('calls')
    .upsert(callData, {
      onConflict: 'vapi_call_id',
      ignoreDuplicates: false
    })
    .select()
    .single();

  if (error) {
    console.error('Error upserting call:', error);
    throw error;
  }

  return data;
}

/**
 * Insert a transcript entry
 * @param {string} callId - UUID of the call
 * @param {string} role - 'user', 'assistant', or 'system'
 * @param {string} text - Transcript text
 * @param {number} sequenceNumber - Order in conversation
 * @returns {Promise<Object>} Created transcript record
 */
async function insertTranscript(callId, role, text, sequenceNumber = null) {
  if (!supabaseService) throw new Error('Supabase service client not initialized');
  
  const { data, error } = await supabaseService
    .from('call_transcripts')
    .insert({
      call_id: callId,
      role,
      text,
      sequence_number: sequenceNumber,
      spoken_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    console.error('Error inserting transcript:', error);
    throw error;
  }

  return data;
}

/**
 * Create a booking record
 * @param {Object} bookingData - Booking data object
 * @returns {Promise<Object>} Created booking record
 */
async function createBooking(bookingData) {
  if (!supabaseService) throw new Error('Supabase service client not initialized');
  
  const { data, error } = await supabaseService
    .from('bookings')
    .insert(bookingData)
    .select()
    .single();

  if (error) {
    console.error('Error creating booking:', error);
    throw error;
  }

  return data;
}

/**
 * Insert a capture-and-confirm booking request.
 * Uses upsert on call_id so a duplicate/redelivered tool call updates the
 * existing row instead of erroring on the unique constraint.
 * @param {Object} requestData - Booking request fields
 * @returns {Promise<Object>} Created/updated booking request record
 */
async function insertBookingRequest(requestData) {
  if (!supabaseService) throw new Error('Supabase service client not initialized');

  const query = requestData.call_id
    ? supabaseService
        .from('booking_requests')
        .upsert(requestData, { onConflict: 'call_id', ignoreDuplicates: false })
    : supabaseService.from('booking_requests').insert(requestData);

  const { data, error } = await query.select().single();

  if (error) {
    console.error('Error inserting booking request:', error);
    throw error;
  }

  return data;
}

/**
 * Get the booking request captured on a given call (if any).
 * @param {string} callId - UUID of the call
 * @returns {Promise<Object|null>} Booking request record or null
 */
async function getBookingRequestByCall(callId) {
  if (!supabaseService) throw new Error('Supabase service client not initialized');
  if (!callId) return null;

  const { data, error } = await supabaseService
    .from('booking_requests')
    .select('*')
    .eq('call_id', callId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching booking request:', error);
    return null;
  }

  return data || null;
}

/**
 * Get the confirmed booking for a call, if one already exists (idempotency).
 * @param {string} callId - UUID of the call
 * @returns {Promise<Object|null>} Booking record or null
 */
async function getBookingByCall(callId) {
  if (!supabaseService) throw new Error('Supabase service client not initialized');
  if (!callId) return null;

  const { data, error } = await supabaseService
    .from('bookings')
    .select('*')
    .eq('call_id', callId)
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching booking by call:', error);
    return null;
  }

  return data || null;
}

/**
 * Get business's Cal.com credentials
 * @param {string} businessId - UUID of the business
 * @returns {Promise<Object|null>} Cal.com credentials or null
 */
async function getCalcomCredentials(businessId) {
  if (!supabaseService) throw new Error('Supabase service client not initialized');
  
  const { data, error } = await supabaseService
    .from('business_integrations')
    .select('*')
    .eq('business_id', businessId)
    .eq('provider', 'calcom')
    .single();

  if (error && error.code !== 'PGRST116') {
    console.error('Error fetching Cal.com credentials:', error);
    return null;
  }

  return data;
}

/**
 * Update business's Cal.com credentials (after OAuth)
 * @param {string} businessId - UUID of the business
 * @param {Object} credentials - Cal.com OAuth tokens
 * @returns {Promise<Object>} Updated integration record
 */
async function updateCalcomCredentials(businessId, credentials) {
  if (!supabaseService) throw new Error('Supabase service client not initialized');
  
  // First check if integration exists
  const existing = await getCalcomCredentials(businessId);
  
  if (existing) {
    // Merge config: keep existing config and update with new values
    const existingConfig = existing.config || {};
    const updatedConfig = {
      ...existingConfig,
      ...(credentials.event_type_id && { event_type_id: credentials.event_type_id })
    };
    
    // Update existing integration
    const { data, error } = await supabaseService
      .from('business_integrations')
      .update({
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token,
        token_expires_at: credentials.expires_at,
        config: updatedConfig
      })
      .eq('id', existing.id)
      .select()
      .single();

    if (error) {
      console.error('Error updating Cal.com credentials:', error);
      throw error;
    }

    return data;
  } else {
    // Create new integration
    const { data, error } = await supabaseService
      .from('business_integrations')
      .insert({
        business_id: businessId,
        provider: 'calcom',
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token,
        token_expires_at: credentials.expires_at,
        config: {
          event_type_id: credentials.event_type_id || null
        }
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating Cal.com credentials:', error);
      throw error;
    }

    return data;
  }
}

/**
 * Get recent calls for a business (for analytics/dashboard)
 * @param {string} businessId - UUID of the business
 * @param {number} limit - Number of calls to retrieve
 * @returns {Promise<Array>} Array of call records
 */
async function getRecentCalls(businessId, limit = 50) {
  if (!supabaseService) throw new Error('Supabase service client not initialized');
  
  const { data, error } = await supabaseService
    .from('calls')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Error fetching recent calls:', error);
    return [];
  }

  return data;
}

module.exports = {
  supabaseService,
  supabaseAnon,
  getBusinessByPhone,
  getBusinessById,
  upsertCall,
  insertTranscript,
  createBooking,
  getBookingByCall,
  insertBookingRequest,
  getBookingRequestByCall,
  getCalcomCredentials,
  updateCalcomCredentials,
  getRecentCalls
};
