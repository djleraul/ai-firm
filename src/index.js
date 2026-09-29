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

const TOOLS = [
  {
    name: "create_task",
    description: "Create a new task in the task database.",
    parameters: {
      type: "object",
      properties: {
        title:       { type: "string",  description: "Short task title." },
        assigned_to: { type: "string",  description: "Assignee: Ava, Rowan, Mira, or Sol." },
        priority:    { type: "string",  enum: ["low", "normal", "high", "critical"] },
        status:      { type: "string",  enum: ["todo", "in_progress", "blocked", "awaiting_approval", "done", "cancelled"] },
        due_date:    { type: "string",  description: "Optional due date in YYYY-MM-DD format." },
        description: { type: "string",  description: "Optional additional detail." },
      },
      required: ["title"],
    },
  },
  {
    name: "update_task",
    description: "Update one or more fields on an existing task by its ID.",
    parameters: {
      type: "object",
      properties: {
        id:          { type: "string", description: "The ID of the task to update." },
        title:       { type: "string" },
        assigned_to: { type: "string" },
        priority:    { type: "string", enum: ["low", "normal", "high", "critical"] },
        status:      { type: "string", enum: ["todo", "in_progress", "blocked", "awaiting_approval", "done", "cancelled"] },
        due_date:    { type: "string" },
        description: { type: "string" },
      },
      required: ["id"],
    },
  },
];

async function handleToolCall(toolCall, env) {
  const args = typeof toolCall.arguments === "string"
    ? JSON.parse(toolCall.arguments)
    : toolCall.arguments;

  if (toolCall.name === "create_task") {
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO tasks (id, title, description, assigned_to, priority, status, due_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      args.title,
      args.description ?? null,
      args.assigned_to ?? null,
      args.priority    ?? "normal",
      args.status      ?? "todo",
      args.due_date    ?? null,
      now,
      now
    ).run();
    return { success: true, id, message: `Task "${args.title}" created with ID ${id}.` };
  }

  if (toolCall.name === "update_task") {
    const { id, ...fields } = args;
    const setClauses = [];
    const values     = [];
    for (const [col, val] of Object.entries(fields)) {
      setClauses.push(`${col} = ?`);
      values.push(val);
    }
    setClauses.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);
    await env.DB.prepare(
      `UPDATE tasks SET ${setClauses.join(", ")} WHERE id = ?`
    ).bind(...values).run();
    return { success: true, message: `Task ${id} updated.` };
  }

  return { success: false, message: `Unknown tool: ${toolCall.name}` };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return json({ error: "Use POST with a JSON body containing a message field." }, 405);
    }

    try {
      const body    = await request.json();
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
            WHEN 'high'     THEN 2
            WHEN 'normal'   THEN 3
            WHEN 'low'      THEN 4
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

Your colleagues: Rowan (Researcher), Mira (Software Engineer), Sol (Editor/Analyst).

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

WRITING TASKS:
- Use create_task when the user asks you to create or add a task.
- Use update_task when the user asks you to change status, priority,
  assignee, or any other field on an existing task.
- After a successful tool call, confirm what was done in plain language.

Actions requiring approval before acting: sending messages, spending money,
publishing, deleting data, or changing instructions.
`;

      // ── First AI call ───────────────────────────────────────────────────────
      const firstResponse = await env.AI.run(MODEL, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: message },
        ],
        tools: TOOLS,
        temperature: 0.2,
      });

      // ── Handle tool calls ───────────────────────────────────────────────────
      if (firstResponse.tool_calls?.length) {
        const toolResultMsgs = await Promise.all(
          firstResponse.tool_calls.map(async (tc) => ({
            role:         "tool",
            name:         tc.name,
            tool_call_id: tc.id ?? tc.name,
            content:      JSON.stringify(await handleToolCall(tc, env)),
          }))
        );

        const secondResponse = await env.AI.run(MODEL, {
          messages: [
            { role: "system",    content: systemPrompt },
            { role: "user",      content: message },
            { role: "assistant", content: firstResponse.response ?? "", tool_calls: firstResponse.tool_calls },
            ...toolResultMsgs,
          ],
          temperature: 0.2,
        });

        return json({ reply: secondResponse.response || "I could not generate a response." });
      }

      // ── No tool calls — return directly ────────────────────────────────────
      return json({ reply: firstResponse.response || "I could not generate a response." });

    } catch (error) {
      console.error("Worker error:", error);
      return json(
        {
          error:   "Unable to process the request.",
          details: error instanceof Error ? error.message : String(error),
        },
        500
      );
    }
  },
};
