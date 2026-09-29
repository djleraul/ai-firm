const MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    if (request.method !== "POST") {
      return json(
        { error: "Use POST with a JSON body containing a message field." },
        405
      );
    }

    try {
      const body = await request.json();
      const message = typeof body.message === "string" ? body.message.trim() : "";

      if (!message) {
        return json({ error: "A non-empty message is required." }, 400);
      }

      const { results: tasks } = await env.DB.prepare(`
        SELECT
          id,
          title,
          description,
          assigned_to,
          status,
          priority,
          created_at,
          updated_at,
          completed_at
        FROM tasks
        ORDER BY
          CASE priority
            WHEN 'critical' THEN 1
            WHEN 'high' THEN 2
            WHEN 'normal' THEN 3
            WHEN 'low' THEN 4
            ELSE 5
          END,
          updated_at DESC
        LIMIT 50
      `).all();

      const taskContext = tasks.length > 0
        ? JSON.stringify(tasks, null, 2)
        : "No task records currently exist.";

      const systemPrompt = `
You are Ava, Chief of Staff for AI Firm.

Your role is to organize priorities, create clear plans, track decisions,
and provide concise operational briefings.

AUTHORITATIVE TASK DATABASE:
${taskContext}

RULES FOR TASK QUESTIONS:
- The task database above is the source of truth for task information.
- If a requested task is present, report its title, status, priority,
  assignee, and relevant description or dates.
- Never say you lack task access or that no task source is connected when
  task records are provided above.
- Do not invent tasks, statuses, assignments, dates, or other details.
- If the requested task is not in the database, say that it was not found.
- Be concise, practical, and honest about uncertainty.

Actions requiring approval: sending messages, spending money, publishing,
deleting data, or changing instructions.
`;

      const result = await env.AI.run(MODEL, {
        messages: [
          {
            role: "system",
            content: systemPrompt,
          },
          {
            role: "user",
            content: message,
          },
        ],
        temperature: 0.2,
      });

      return json({
  reply: result.response || "I could not generate a response.",
  debug: {
    taskCount: tasks.length,
    taskTitles: tasks.map((task) => task.title),
    databaseConfigured: Boolean(env.DB),
  },
});

    } catch (error) {
      console.error("Worker error:", error);

      return json(
        {
          error: "Unable to process the request.",
          details: error instanceof Error ? error.message : String(error),
        },
        500
      );
    }
  },
};
