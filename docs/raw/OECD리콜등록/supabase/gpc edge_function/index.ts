// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Using direct URLs as per the previously working code structure for Supabase Edge environment
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { OpenAI } from "https://esm.sh/openai@4.20.1"; // Specify a version for stability

const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_SIMILARITY_THRESHOLD = 0.75; // Default threshold if not provided by client
const MATCH_COUNT = 1; // We typically want the top 1 match

interface ProductInfo {
  productName: string;
  productDescription?: string;
  similarityThreshold?: number; // Optional threshold from client
}

// Define the expected structure of the response to the client
interface GpcServiceResponse {
  brick_code: string | null;
  brick_name_ko?: string | null;
  segment_code: string | null;
  segment_name_ko?: string | null;
  family_code: string | null;
  family_name_ko?: string | null;
  class_code: string | null;
  class_name_ko?: string | null;
  similarity: number | null;
  error?: string | null; // Optional error message for the client
  appliedThreshold?: number; // To inform client which threshold was used
}

// --- Initialize Supabase and OpenAI clients ---
let supabase: SupabaseClient | null = null;
let openai: OpenAI | null = null;
let clientsInitializationError: string | null = null;

try {
  console.log("Attempting to initialize Supabase and OpenAI clients...");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const openaiApiKey = Deno.env.get("OPENAI_API_KEY");

  if (!supabaseUrl) throw new Error("SUPABASE_URL environment variable is missing.");
  if (!supabaseServiceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY environment variable is missing.");
  if (!openaiApiKey) throw new Error("OPENAI_API_KEY environment variable is missing.");

  supabase = createClient(supabaseUrl, supabaseServiceKey, {
    global: { fetch: fetch },
    auth: { persistSession: false },
  });
  openai = new OpenAI({ apiKey: openaiApiKey });
  console.log("Supabase and OpenAI clients initialized successfully.");
} catch (error) {
  clientsInitializationError = error instanceof Error ? error.message : "Unknown error during client initialization.";
  console.error("CRITICAL Client Initialization Error:", clientsInitializationError);
}

serve(async (req: Request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (clientsInitializationError || !supabase || !openai) {
    console.error("Aborting request: Clients are not initialized due to startup error:", clientsInitializationError);
    return new Response(
      JSON.stringify({ error: `Server configuration error: ${clientsInitializationError || "Clients not available."}` }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  let responsePayload: GpcServiceResponse = {
    brick_code: null,
    segment_code: null,
    family_code: null,
    class_code: null,
    similarity: null,
    appliedThreshold: DEFAULT_SIMILARITY_THRESHOLD, // Default
    brick_name_ko: null,
    segment_name_ko: null,
    family_name_ko: null,
    class_name_ko: null,
  };

  try {
    const { productName, productDescription, similarityThreshold }: ProductInfo = await req.json();
    console.log(
      `Request received: productName="${productName}", desc="${
        productDescription ? productDescription.substring(0, 30) : ""
      }...", threshold=${similarityThreshold}`
    );

    const currentThreshold =
      typeof similarityThreshold === "number" && similarityThreshold > 0 && similarityThreshold <= 1
        ? similarityThreshold
        : DEFAULT_SIMILARITY_THRESHOLD;
    responsePayload.appliedThreshold = currentThreshold; // Store the actual threshold used

    if (!productName || typeof productName !== "string" || !productName.trim()) {
      console.warn("Invalid request: productName is missing or invalid.");
      return new Response(JSON.stringify({ error: "productName is required and must be a non-empty string." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const inputText = `${productName}: ${productDescription || ""}`.trim();

    if (!inputText) {
      console.warn("Empty input text for embedding. Returning empty GPC codes.");
      return new Response(JSON.stringify(responsePayload), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        status: 200,
      });
    }

    console.log(`[Vector Search] Generating embedding for: "${inputText.substring(0, 100)}..." using model ${OPENAI_EMBEDDING_MODEL}`);
    try {
      const embeddingResponse = await openai.embeddings.create({
        model: OPENAI_EMBEDDING_MODEL,
        input: inputText,
      });

      if (!embeddingResponse.data || embeddingResponse.data.length === 0 || !embeddingResponse.data[0].embedding) {
        console.error("[Vector Search] Invalid embedding response from OpenAI API:", embeddingResponse);
        responsePayload.error = "Failed to generate text embedding: Invalid API response.";
      } else {
        const queryEmbedding = embeddingResponse.data[0].embedding;
        const queryEmbeddingString = `[${queryEmbedding.join(",")}]`;

        console.log(`[Vector Search] Calling RPC 'match_gpc_vector' with threshold: ${currentThreshold}, count: ${MATCH_COUNT}`);
        const { data: rpcData, error: rpcError } = await supabase.rpc("match_gpc_vector", {
          query_embedding: queryEmbeddingString,
          match_threshold: currentThreshold, // Use dynamic threshold
          match_count: MATCH_COUNT,
        });

        if (rpcError) {
          console.error("[Vector Search] Supabase RPC Error (match_gpc_vector):", rpcError);
          responsePayload.error = `Database search failed: ${rpcError.message}`;
        } else {
          console.log("[Vector Search] Raw RPC Data (match_gpc_vector):", JSON.stringify(rpcData));
          if (Array.isArray(rpcData) && rpcData.length > 0) {
            const topMatch = rpcData[0];
            responsePayload = {
              ...responsePayload, // Preserve appliedThreshold and potential earlier error
              brick_code: topMatch.brick_code || null,
              brick_name_ko: topMatch.brick_name_ko || null,
              segment_code: topMatch.segment_code || null,
              segment_name_ko: topMatch.segment_name_ko || null,
              family_code: topMatch.family_code || null,
              family_name_ko: topMatch.family_name_ko || null,
              class_code: topMatch.class_code || null,
              class_name_ko: topMatch.class_name_ko || null,
              similarity: typeof topMatch.similarity === "number" ? topMatch.similarity : null,
              // error field is handled by being preserved or set by embedding/RPC errors
            };
            console.log(
              `[Vector Search] Top match processed: Brick=${responsePayload.brick_code}, Name=${responsePayload.brick_name_ko}, Sim=${responsePayload.similarity}`
            );
          } else {
            console.log("[Vector Search] No results found from RPC 'match_gpc_vector' with current threshold.");
          }
        }
      }
    } catch (error: unknown) {
      const specificErrorMsg = error instanceof Error ? error.message : "Unknown error during vector search process.";
      console.error("[Vector Search] Exception in vector search process:", specificErrorMsg, error);
      responsePayload.error = responsePayload.error || `Vector search process failed: ${specificErrorMsg}`;
    }

    console.log(`[Result] Final payload: ${JSON.stringify(responsePayload)}`);
    return new Response(JSON.stringify(responsePayload), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: responsePayload.error ? 500 : 200,
    });
  } catch (error: unknown) {
    const generalErrorMsg = error instanceof Error ? error.message : "General internal server error.";
    console.error("General Unhandled Error in serve function:", generalErrorMsg, error);
    return new Response(JSON.stringify({ error: generalErrorMsg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
