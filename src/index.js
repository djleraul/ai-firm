export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const userMessage = body.message;
    if (!userMessage) {
      return new Response(JSON.stringify({ error: "Missing 'message' field." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const systemPrompt = `You are Ava, Chief of Staff at AI Firm.
Your role is to organize priorities, create tasks and plans, track decisions, and prepare briefings.
You have access to the task database and can read and write tasks.
Do not invent facts about AI Firm. Do not claim a physical body or location.
Always require approval before sending messages, spending money, publishing content, deleting data, or changing instructions.
Be concise, practical, and honest about uncertainty.

Agents:
- Ava (Chief of Staff)
- Rowan (Researcher)
- Mira (Software Engineer)
- Sol (Editor/Analyst)

Valid statuses: todo, in_progress, blocked, awaiting_approval, done, cancelled
Valid priorities: low, normal, high, critical`;

    const tools = [
      {
        name: "list_tasks",
        description: "List all tasks in the database, optionally filtered by status or assigned agent.",
        parameters: {
          type: "object",
          properties: {
            status: {
              type: "string",
              description: "Filter by status (todo, in_progress, blocked, awaiting_approval, done, cancelled). Omit to return all.",
            },
            assigned_to: {
              type: "string",
              description: "Filter by agent name (e.g. Mira, Sol). Omit to return all.",
            },
          },
          required: [],
        },
      },
      {
        name: "create_task",
        description: "Create a new task and insert it into the database.",
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "A short title for the task.",
            },
            assigned_to: {
              type: "string",
              description: "The agent this task is assigned to.",
            },
            priority: {
              type: "string",
              description: "Priority level: low, normal, high, or critical.",
            },
            status: {
              type: "string",
              description: "Initial status. Defaults to 'todo' if omitted.",
            },
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
            id: {
              type: "string",
              description: "The UUID of the task to update.",
            },
            title: { type: "string" },
            assigned_to: { type: "string" },
            priority: { type: "string" },
            status: { type: "string" },
          },
          required: ["id"],
        },
      },
    ];

    // --- First AI call ---
    let aiResponse;
    try {
      aiResponse = await env.AI.run("@hf/nousresearch/hermes-2-pro-mistral-7b", {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        tools,
        temperature: 0.2,
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "AI call failed.", details: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // --- Tool execution ---
    let toolResultContent = null;
    let calledToolName = null;

    if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
      const toolCall = aiResponse.tool_calls[0];
      calledToolName = toolCall.name;
      const args = toolCall.arguments ?? {};

      try {
        if (calledToolName === "list_tasks") {
          let query = "SELECT id, title, assigned_to, priority, status, created_at, updated_at FROM tasks";
          const conditions = [];
          const params = [];

          if (args.status) {
            conditions.push("status = ?");
            params.push(args.status);
          }
          if (args.assigned_to) {
            conditions.push("assigned_to = ?");
            params.push(args.assigned_to);
          }
          if (conditions.length > 0) {
            query += " WHERE " + conditions.join(" AND ");
          }
          query += " ORDER BY created_at DESC";

          const result = await env.DB.prepare(query).bind(...params).all();
          toolResultContent = JSON.stringify(result.results);

        } else if (calledToolName === "create_task") {
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          const title = args.title;
          const assigned_to = args.assigned_to ?? null;
          const priority = args.priority ?? "normal";
          const status = args.status ?? "todo";

          await env.DB.prepare(
            "INSERT INTO tasks (id, title, assigned_to, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
          )
            .bind(id, title, assigned_to, priority, status, now, now)
            .run();

          toolResultContent = JSON.stringify({ success: true, id, title, assigned_to, priority, status });

        } else if (calledToolName === "update_task") {
          const { id, ...fields } = args;
          const allowed = ["title", "assigned_to", "priority", "status"];
          const setClauses = [];
          const params = [];

          for (const key of allowed) {
            if (fields[key] !== undefined) {
              setClauses.push(`${key} = ?`);
              params.push(fields[key]);
            }
          }

          if (setClauses.length === 0) {
            toolResultContent = JSON.stringify({ success: false, error: "No valid fields to update." });
          } else {
            const now = new Date().toISOString();
            setClauses.push("updated_at = ?");
            params.push(now);
            params.push(id);

            await env.DB.prepare(
              `UPDATE tasks SET ${setClauses.join(", ")} WHERE id = ?`
            )
              .bind(...params)
              .run();

            toolResultContent = JSON.stringify({ success: true, id, updated: fields });
          }
        } else {
          toolResultContent = JSON.stringify({ error: "Unknown tool." });
        }
      } catch (err) {
        return new Response(
          JSON.stringify({ error: "Tool execution failed.", details: err.message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // --- Second AI call (if a tool was used) ---
    let finalReply;

    if (calledToolName && toolResultContent !== null) {
      try {
        const secondResponse = await env.AI.run("@hf/nousresearch/hermes-2-pro-mistral-7b", {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
            { role: "assistant", content: `Tool used: ${calledToolName}` },
            { role: "tool", content: toolResultContent },
          ],
          temperature: 0.2,
        });
        finalReply = secondResponse.response ?? "Done.";
      } catch (err) {
        return new Response(
          JSON.stringify({ error: "Second AI call failed.", details: err.message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    } else {
      finalReply = aiResponse.response ?? "No response generated.";
    }

    return new Response(JSON.stringify({ reply: finalReply }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
