export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("POST only", { status: 405 });
    }

    try {
      const body = await request.json();
      const userMessage = body.message || "";

      if (!userMessage.trim()) {
        return new Response(
          JSON.stringify({ reply: "Please provide a message." }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      // --- STEP 1: PRE-FETCH TASKS FROM D1 ---
      console.log("=== STEP 1: PRE-FETCH TASKS ===");
      const tasksResult = await env.DB.prepare(
        "SELECT id, title, description, assigned_to, status, priority FROM tasks ORDER BY id"
      ).all();

      console.log("Tasks fetch result:", JSON.stringify(tasksResult, null, 2));
      const tasks = tasksResult.results || [];
      console.log("Tasks array:", JSON.stringify(tasks, null, 2));
      console.log("Total tasks fetched:", tasks.length);

      // --- STEP 2: DETECT INTENT (CREATE OR UPDATE) ---
      console.log("=== STEP 2: INTENT DETECTION ===");
      const createPattern = /create|add|new task|make a task/i;
      const updatePattern = /update|change|mark|set|complete|finish|move|done|in_progress|blocked/i;

      const isCreate = createPattern.test(userMessage);
      const isUpdate = updatePattern.test(userMessage);
      console.log("User message:", userMessage);
      console.log("Is CREATE intent:", isCreate);
      console.log("Is UPDATE intent:", isUpdate);

      let writeResult = "";

      // --- STEP 3: STRUCTURED EXTRACTION (IF WRITE INTENT DETECTED) ---
      if (isCreate || isUpdate) {
        console.log("=== STEP 3: STRUCTURED EXTRACTION ===");
        const extractionPrompt = isCreate
          ? `Extract JSON for a NEW TASK from: "${userMessage}"
             Return: { "title": "...", "description": "...", "assigned_to": "Ava|Rowan|Mira|Sol", "priority": "low|normal|high|critical" }
             If missing, use reasonable defaults. Return ONLY valid JSON.`
          : `Extract JSON for UPDATING a task from: "${userMessage}"
             Return: { "task_id": <number or null>, "status": "todo|in_progress|blocked|awaiting_approval|done|cancelled" or null, "priority": "low|normal|high|critical" or null }
             Return ONLY valid JSON.`;

        console.log("Extraction prompt:", extractionPrompt);

        let extractedData = null;
        try {
          const extractionResponse = await env.AI.run(
            "@cf/zai-org/glm-4.7-flash",
            {
              prompt: extractionPrompt,
              temperature: 0.1,
              max_tokens: 500,
            }
          );
          console.log("Extraction response:", extractionResponse);

          const responseText =
            extractionResponse.response ||
            extractionResponse.result ||
            JSON.stringify(extractionResponse);
          console.log("Response text:", responseText);

          // Extract JSON from response
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            extractedData = JSON.parse(jsonMatch[0]);
            console.log("Parsed extracted data:", extractedData);
          }
        } catch (extractError) {
          console.error("Extraction error:", extractError);
        }

        // --- PERFORM WRITE OPERATION ---
        if (extractedData) {
          console.log("=== STEP 4: WRITE OPERATION ===");
          try {
            if (isCreate && extractedData.title) {
              console.log("Creating task:", extractedData);
              const insertResult = await env.DB.prepare(
                `INSERT INTO tasks (title, description, assigned_to, status, priority)
                 VALUES (?, ?, ?, ?, ?)`
              ).bind(
                extractedData.title,
                extractedData.description || "",
                extractedData.assigned_to || "Ava",
                "todo",
                extractedData.priority || "normal"
              ).run();

              writeResult = `✓ Task created: "${extractedData.title}"`;
              console.log("Insert result:", insertResult);
            } else if (isUpdate && extractedData.task_id && extractedData.status) {
              console.log("Updating task:", extractedData);
              const updateFields = [];
              const updateValues = [];

              if (extractedData.status) {
                updateFields.push("status = ?");
                updateValues.push(extractedData.status);
              }
              if (extractedData.priority) {
                updateFields.push("priority = ?");
                updateValues.push(extractedData.priority);
              }

              if (updateFields.length > 0) {
                updateValues.push(extractedData.task_id);
                const updateResult = await env.DB.prepare(
                  `UPDATE tasks SET ${updateFields.join(", ")} WHERE id = ?`
                ).bind(...updateValues).run();

                writeResult = `✓ Task ${extractedData.task_id} updated`;
                console.log("Update result:", updateResult);
              }
            }
          } catch (writeError) {
            console.error("Write operation error:", writeError);
            writeResult = `✗ Write failed: ${writeError.message}`;
          }
        }
      }

      // --- STEP 5: GENERATE FINAL RESPONSE WITH FULL CONTEXT ---
      console.log("=== STEP 5: FINAL AI CALL ===");

      // Build tasks context string
      const tasksContext =
        tasks.length > 0
          ? `Current tasks in database:\n${tasks
              .map(
                (t) =>
                  `• [${t.id}] "${t.title}" (assigned: ${t.assigned_to}, status: ${t.status}, priority: ${t.priority})`
              )
              .join("\n")}`
          : "No tasks in database yet.";

      const systemPrompt = `You are Ava, Chief of Staff at AI Firm.
Your role: organize priorities, create tasks, track decisions, prepare briefings.
Always be concise, practical, and honest about what you know.
Do not invent facts about AI Firm or pretend to have a physical body.
Agents: Ava (Chief of Staff), Rowan (Researcher), Mira (Software Engineer), Sol (Editor/Analyst).

${tasksContext}

${writeResult ? `Action just taken: ${writeResult}` : ""}`;

      console.log("=== FINAL AI CALL ===");
      console.log("System prompt length:", systemPrompt.length);
      console.log("System prompt:", systemPrompt);
      console.log("User message:", userMessage);
      console.log("=== END DEBUG ===");

      let finalReply;
      try {
        const aiResponse = await env.AI.run("@cf/zai-org/glm-4.7-flash", {
          prompt: systemPrompt + "\n\nUser: " + userMessage,
          temperature: 0.2,
          max_tokens: 500,
        });

        console.log("AI response object:", JSON.stringify(aiResponse, null, 2));

        finalReply =
          aiResponse.response ||
          aiResponse.result ||
          JSON.stringify(aiResponse);
      } catch (aiError) {
        console.error("AI call error:", aiError);
        finalReply = `Error calling AI: ${aiError.message}`;
      }

      console.log("Final reply:", finalReply);

      return new Response(JSON.stringify({ reply: finalReply }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Top-level error:", error);
      return new Response(
        JSON.stringify({ error: error.message || "Unknown error" }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  },
};
