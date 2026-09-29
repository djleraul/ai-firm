$code = @'
const AVA_INSTRUCTIONS = `
You are Ava, the chief of staff for AI Firm.

IDENTITY
- Your name is Ava.
- AI Firm is the organization you work for, not your name.
- If asked your name, reply: "My name is Ava."

GROUNDING RULES – FOLLOW THESE BEFORE ANSWERING
- Do not invent facts about AI Firm, its office, city, employees, customers, projects, meetings, finances, systems, or task status.
- Do not claim to have a physical body, desk, office, conference room, city, or location.
- Do not imply that you can see, access, remember, send, change, publish, purchase, delete, or manage anything unless that capability and information have been explicitly provided in this conversation.
- Treat information supplied by the user or connected tools/database as known. Treat everything else about AI Firm as unknown.
- When information is unknown, say so plainly, then offer a useful next step. Never fill gaps with plausible-sounding details.

EXAMPLES
User: "Where are you?"
Ava: "I don't have a physical location. I'm Ava, the chief of staff for AI Firm."

User: "What is the status of our projects?"
Ava: "I don't have project status information yet. Share the projects or connect a task source, and I can organize a status briefing."

User: "Who is on our team?"
Ava: "I only know the team information you provide or that is available in connected records."

ROLE
Help the user:
- Organize priorities
- Turn ideas into concrete tasks
- Create practical plans
- Track decisions and open questions
- Prepare briefings from information the user provides

APPROVALS
Ask for explicit approval before sending messages, spending money, publishing, deleting data, or changing instructions.

STYLE
Be concise, practical, helpful, and honest about uncertainty.
`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const VALID_STATUSES = [
  "todo",
  "in_progress",
  "blocked",
  "awaiting_approval",
  "done",
  "cancelled",
];

const VALID_PRIORITIES = [
  "low",
  "normal",
  "high",
  "critical",
];

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

function isValidStatus(status) {
  return VALID_STATUSES.includes(status);
}

function isValidPriority(priority) {
  return VALID_PRIORITIES.includes(priority);
}

function isValidTaskId(taskId) {
  return /^task_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    taskId
  );
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /tasks
      if (request.method === "GET" && path === "/tasks") {
        const { results } = await env.DB.prepare(`
          SELECT
            id,
            title,
            description,
            status,
            priority,
            assigned_to,
            created_at,
            updated_at
          FROM tasks
          ORDER BY
            CASE priority
              WHEN 'critical' THEN 1
              WHEN 'high' THEN 2
              WHEN 'normal' THEN 3
              WHEN 'low' THEN 4
            END,
            created_at DESC
        `).all();

        return json({ tasks: results });
      }

      // POST /tasks
      if (request.method === "POST" && path === "/tasks") {
        const body = await request.json();

        if (!body.title || typeof body.title !== "string") {
          return json({ error: "A task title is required." }, 400);
        }

        const title = body.title.trim();

        if (!title) {
          return json({ error: "A task title is required." }, 400);
        }

        const description =
          typeof body.description === "string"
            ? body.description.trim()
            : "";

        const status = isValidStatus(body.status) ? body.status : "todo";
        const priority = isValidPriority(body.priority)
          ? body.priority
          : "normal";

        const assignedTo =
          typeof body.assigned_to === "string" && body.assigned_to.trim()
            ? body.assigned_to.trim()
            : "Ava";

        const taskId = `task_${crypto.randomUUID()}`;

        await env.DB.prepare(`
          INSERT INTO tasks (
            id,
            title,
            description,
            status,
            priority,
            assigned_to,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `)
          .bind(
            taskId,
            title,
            description,
            status,
            priority,
            assignedTo
          )
          .run();

        const task = await env.DB.prepare(`
          SELECT * FROM tasks WHERE id = ?
        `)
          .bind(taskId)
          .first();

        return json({ task }, 201);
      }

      // PATCH /tasks/:id
      if (request.method === "PATCH" && path.startsWith("/tasks/")) {
        const taskId = path.split("/")[2];

        if (!isValidTaskId(taskId)) {
          return json({ error: "A valid task ID is required." }, 400);
        }

        const existingTask = await env.DB.prepare(`
          SELECT * FROM tasks WHERE id = ?
        `)
          .bind(taskId)
          .first();

        if (!existingTask) {
          return json({ error: "Task not found." }, 404);
        }

        const body = await request.json();

        const title =
          typeof body.title === "string" && body.title.trim()
            ? body.title.trim()
            : existingTask.title;

        const description =
          typeof body.description === "string"
            ? body.description.trim()
            : existingTask.description;

        const status = body.status
          ? isValidStatus(body.status)
            ? body.status
            : null
          : existingTask.status;

        const priority = body.priority
          ? isValidPriority(body.priority)
            ? body.priority
            : null
          : existingTask.priority;

        const assignedTo =
          typeof body.assigned_to === "string" && body.assigned_to.trim()
            ? body.assigned_to.trim()
            : existingTask.assigned_to;

        if (!status) {
          return json({ error: "Invalid task status." }, 400);
        }

        if (!priority) {
          return json({ error: "Invalid task priority." }, 400);
        }

        await env.DB.prepare(`
          UPDATE tasks
          SET
            title = ?,
            description = ?,
            status = ?,
            priority = ?,
            assigned_to = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
          .bind(
            title,
            description,
            status,
            priority,
            assignedTo,
            taskId
          )
          .run();

        const task = await env.DB.prepare(`
          SELECT * FROM tasks WHERE id = ?
        `)
          .bind(taskId)
          .first();

        return json({ task });
      }

      // POST / – Ava chat with task context
      if (request.method === "POST" && path === "/") {
        const body = await request.json();

        if (!body.message || typeof body.message !== "string") {
          return json({ error: "A message is required." }, 400);
        }

        console.log("[STEP 1] PRE-FETCH: Requesting all tasks from D1...");

        // STEP 1: Pre-fetch all tasks
        const { results: tasks } = await env.DB.prepare(`
          SELECT
            id,
            title,
            description,
            status,
            priority,
            assigned_to,
            created_at,
            updated_at
          FROM tasks
          ORDER BY
            CASE priority
              WHEN 'critical' THEN 1
              WHEN 'high' THEN 2
              WHEN 'normal' THEN 3
              WHEN 'low' THEN 4
            END,
            created_at DESC
        `).all();

        console.log(`[STEP 1] TASKS RETRIEVED: ${tasks.length} tasks fetched`);
        if (tasks.length > 0) {
          console.log(`[STEP 1] Sample task: ${JSON.stringify(tasks[0])}`);
        }

        // STEP 2: Build task context for system prompt
        let taskContext = "";
        if (tasks && tasks.length > 0) {
          taskContext = "\n\nCURRENT TASKS:\n";
          tasks.forEach((task, idx) => {
            taskContext += `${idx + 1}. [${task.id}] ${task.title}\n`;
            taskContext += `   Status: ${task.status} | Priority: ${task.priority} | Assigned to: ${task.assigned_to}\n`;
            if (task.description) {
              taskContext += `   Description: ${task.description}\n`;
            }
          });
        } else {
          taskContext = "\n\nNOTE: No tasks exist yet.";
        }

        console.log(`[STEP 2] TASK CONTEXT LENGTH: ${taskContext.length} chars`);
        console.log(`[STEP 2] TASK CONTEXT:\n${taskContext}`);

        // STEP 3: Build final system prompt with task context
        const systemPromptWithTasks = AVA_INSTRUCTIONS + taskContext;

        console.log(`[STEP 3] FINAL SYSTEM PROMPT LENGTH: ${systemPromptWithTasks.length} chars`);
        console.log(`[STEP 3] SENDING TO AI WITH MESSAGE: "${body.message}"`);

        // STEP 4: Call AI with task context injected
        const result = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fp8",
          {
            messages: [
              {
                role: "system",
                content: systemPromptWithTasks,
              },
              {
                role: "user",
                content: body.message,
              },
            ],
            temperature: 0.2,
          }
        );

        console.log(`[STEP 4] AI RESPONSE RECEIVED: ${result.response ? result.response.substring(0, 100) + "..." : "empty"}`);

        return json({
          reply: result.response ?? "I was unable to generate a response.",
        });
      }

      return json({ error: "Route not found." }, 404);
    } catch (error) {
      console.error(`[ERROR] ${error.message}`);

      return json(
        {
          error: error instanceof Error ? error.message : "Worker error",
        },
        500
      );
    }
  },
};
'@

Set-Content -Path src/index.js -Value $code
Write-Host "✅ src/index.js updated with task injection and debug logging"
