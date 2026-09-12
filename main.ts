import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// Environment variables configured in Deno
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const QUALTRICS_API_TOKEN = Deno.env.get("QUALTRICS_API_TOKEN");
const QUALTRICS_SURVEY_ID = Deno.env.get("QUALTRICS_SURVEY_ID");
const QUALTRICS_DATACENTER = Deno.env.get("QUALTRICS_DATACENTER");
const SYLLABUS_LINK = Deno.env.get("SYLLABUS_LINK") || "";
const OPENAI_MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
const PORT = Number(Deno.env.get("PORT") || "8000");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

serve(
  async (req: Request): Promise<Response> => {
    // CORS preflight request
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Deno health check and browser test
    if (req.method === "GET" || req.method === "HEAD") {
      return new Response("Syllabus chatbot server is running.", {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    if (req.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: corsHeaders,
      });
    }

    // Verify that the OpenAI key exists
    if (!OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY is missing.");

      return new Response(
        "Server configuration error: Missing OpenAI API key.",
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }

    // Read and validate the submitted question
    let body: { query?: string };

    try {
      body = await req.json();
    } catch {
      return new Response("Invalid JSON request.", {
        status: 400,
        headers: corsHeaders,
      });
    }

    const query = body.query?.trim();

    if (!query) {
      return new Response("Please enter a question.", {
        status: 400,
        headers: corsHeaders,
      });
    }

    // Load syllabus.md from the GitHub/Deno project
    let syllabus: string;

    try {
      syllabus = await Deno.readTextFile("syllabus.md");
    } catch (error) {
      console.error("Could not load syllabus.md:", error);

      return new Response(
        "Server error: Could not load the syllabus.",
        {
          status: 500,
          headers: corsHeaders,
        },
      );
    }

    // Ask OpenAI to answer only from the syllabus
    let result: string;

    try {
      const openaiResponse = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: OPENAI_MODEL,
            messages: [
              {
                role: "system",
                content:
                  `You are an accurate university syllabus assistant.

Answer the student's question using only the syllabus supplied below.

Rules:
- Do not invent information.
- If the answer is not found in the syllabus, clearly say that it is not specified in the syllabus.
- When the question identifies a course number, use the information for that course.
- Carefully distinguish POL SCI 2141 from POL SCI 2191.
- Give clear, concise answers.
- Include the course webpage link when appropriate.

COURSE SYLLABUS:
${syllabus}`,
              },
              {
                role: "user",
                content: query,
              },
            ],
            max_tokens: 1500,
            temperature: 0.2,
          }),
        },
      );

      const openaiJson = await openaiResponse.json();

      if (!openaiResponse.ok) {
        console.error(
          "OpenAI API error:",
          openaiResponse.status,
          openaiJson,
        );

        const errorMessage =
          openaiJson?.error?.message || "Unknown OpenAI API error";

        return new Response(
          `OpenAI request failed (${openaiResponse.status}): ${errorMessage}`,
          {
            status: 502,
            headers: {
              ...corsHeaders,
              "Content-Type": "text/plain; charset=utf-8",
            },
          },
        );
      }

      result =
        openaiJson?.choices?.[0]?.message?.content?.trim() ||
        "No response was returned by OpenAI.";
    } catch (error) {
      console.error("Error contacting OpenAI:", error);

      return new Response("The server could not contact OpenAI.", {
        status: 502,
        headers: corsHeaders,
      });
    }

    const sourceMessage = SYLLABUS_LINK
      ? `\n\nThere may be errors in this response. Always verify the information using the official course page: ${SYLLABUS_LINK}`
      : "\n\nThere may be errors in this response. Always verify the information using the official course syllabus.";

    const finalResponse = `${result}${sourceMessage}`;

    // Optional anonymous Qualtrics logging
    let qualtricsStatus = "Qualtrics not configured";

    if (
      QUALTRICS_API_TOKEN &&
      QUALTRICS_SURVEY_ID &&
      QUALTRICS_DATACENTER
    ) {
      try {
        const qualtricsResponse = await fetch(
          `https://${QUALTRICS_DATACENTER}.qualtrics.com/API/v3/surveys/${QUALTRICS_SURVEY_ID}/responses`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-TOKEN": QUALTRICS_API_TOKEN,
            },
            body: JSON.stringify({
              values: {
                queryText: query,
                responseText: finalResponse,
              },
            }),
          },
        );

        qualtricsStatus = `Qualtrics status: ${qualtricsResponse.status}`;

        if (!qualtricsResponse.ok) {
          console.error(
            "Qualtrics logging failed:",
            qualtricsResponse.status,
            await qualtricsResponse.text(),
          );
        }
      } catch (error) {
        qualtricsStatus = "Qualtrics request failed";
        console.error("Qualtrics error:", error);
      }
    }

    return new Response(
      `${finalResponse}\n<!-- ${qualtricsStatus} -->`,
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/plain; charset=utf-8",
        },
      },
    );
  },
  {
    hostname: "0.0.0.0",
    port: PORT,
  },
);
