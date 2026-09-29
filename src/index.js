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

    // --- Always fetch current tasks from DB ---
    let tasks = [];
    try {
      const result = await env.DB.prepare(
        "SELECT id, title, assigned_to, priority, status, created_at, updated_at FROM tasks ORDER BY created_at DESC"
      ).all();
      tasks = result.results;
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "DB read failed.", details: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // --- Detect write intent ---
    const msg = userMessage.toLowerCase();
    const isCreate = /create|add|new task|make a task/.test(msg);
    const isUpdate = /update|change|mark|set|complete|finish|move|done|in_progress|blocked/.test(msg);

    let writeResult = null;

    if (isCreate) {
      // Ask AI to extract task fields as JSON
      let extracted;
      try {
        const extractResponse = await env.AI.run("@hf/nousresearch/hermes-2-pro-mistral-7b", {
          messages: [
            {
              role: "system",
              content: `Extract task details from the user message and return ONLY valid JSON with these fields:
{"title": string, "assigned_to": string|null, "priority": "low"|"normal"|"high"|"critical", "status": "todo"}
No explanation. No markdown. Just the JSON object.`
            },
            { role: "user", content: userMessage },
          ],
          temperature: 0.1,
        });

        const raw = extractResponse.response?.trim();
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        extracted = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      } catch {
        extracted = null;
      }

      if (extracted?.title) {
        try {
          const id = crypto.randomUUID();
          const now = new Date().toISOString();
          await env.DB.prepare(
            "INSERT INTO tasks (id, title, assigned_to, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
          )
            .bind(
              id,
              extracted.title,
              extracted.assigned_to ?? null,
              extracted.priority ?? "normal",
              extracted.status ?? "todo",
              now,
              now
            )
            .run();

          writeResult = `Task created: "${extracted.title}" assigned to ${extracted.assigned_to ?? "nobody"}, priority ${extracted.priority ?? "normal"}.`;

          // Refresh task list after write
          const refreshed = await env.DB.prepare(
            "SELECT id, title, assigned_to, priority, status, created_at, updated_at FROM tasks ORDER BY created_at DESC"
          ).all();
          tasks = refreshed.results;
        } catch (err) {
          return new Response(
            JSON.stringify({ error: "Task creation failed.", details: err.message }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      }
    }

    if (isUpdate && !isCreate) {
      // Ask AI to extract update fields as JSON
      let extracted;
      try {
        const extractResponse = await env.AI.run("@hf/nousresearch/hermes-2-pro-mistral-7b", {
          messages: [
            {
              role: "system",
              content: `Given the task list below and the user message, return ONLY valid JSON with these fields:
{"id": string, "fields": {"status"?: string, "priority"?: string, "assigned_to"?: string, "title"?: string}}
Use the exact task ID from the list. No explanation. No markdown. Just the JSON object.

Tasks:
${JSON.stringify(tasks, null, 2)}`
            },
            { role: "user", content: userMessage },
          ],
          temperature: 0.1,
        });

        const raw = extractResponse.response?.trim();
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        extracted = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      } catch {
        extracted = null;
      }

      if (extracted?.id && extracted?.fields) {
        try {
          const allowed = ["title", "assigned_to", "priority", "status"];
          const setClauses = [];
          const params = [];

          for (const key of allowed) {
            if (extracted.fields[key] !== undefined) {
              setClauses.push(`${key} = ?`);
              params.push(extracted.fields[key]);
            }
          }

          if (setClauses.length > 0) {
            const now = new Date().toISOString();
            setClauses.push("updated_at = ?");
            params.push(now);
            params.push(extracted.id);

            await env.DB.prepare(
              `UPDATE tasks SET ${setClauses.join(", ")} WHERE id = ?`
            )
              .bind(...params)
              .run();

            writeResult = `Task ${extracted.id} updated: ${JSON.stringify(extracted.fields)}.`;

            // Refresh task list after write
            const refreshed = await env.DB.prepare(
              "SELECT id, title, assigned_to, priority, status, created_at, updated_at FROM tasks ORDER BY created_at DESC"
            ).all();
            tasks = refreshed.results;
          }
        } catch (err) {
          return new Response(
            JSON.stringify({ error: "Task update failed.", details: err.message }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      }
    }

    // --- Final AI call with full context ---
    const systemPrompt = `You are Ava, Chief of Staff at AI Firm.
Your role is to organize priorities, create tasks and plans, track decisions, and prepare briefings.
Be concise, practical, and honest about uncertainty.
Do not invent facts about AI Firm. Do not claim a physical body or location.
Always require approval before sending messages, spending money, publishing content, deleting data, or changing instructions.

Agents: Ava (Chief of Staff), Rowan (Researcher), Mira (Software Engineer), Sol (Editor/Analyst)
Valid statuses: todo, in_progress, blocked, awaiting_approval, done, cancelled
Valid priorities: low, normal, high, critical

Current tasks in the database:
${JSON.stringify(tasks, null, 2)}

${writeResult ? `Action just taken: ${writeResult}` : ""}`;

    let finalReply;
    try {
      const aiResponse = await env.AI.run("@hf/nousresearch/hermes-2-pro-mistral-7b", {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.2,
      });
      finalReply = aiResponse.response ?? "Done.";
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "AI call failed.", details: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ reply: finalReply }), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
