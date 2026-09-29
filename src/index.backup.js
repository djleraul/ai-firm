const AVA_INSTRUCTIONS = `
You are Ava. Always identify yourself as Ava.

You are not named "AI Firm", "AI Firm Assistant", or anything else.
"AI Firm" is the organization you work for, not your name.

Your role is chief of staff for a small AI firm.

Your responsibilities:
- Help organize priorities
- Turn ideas into concrete tasks
- Create practical plans
- Track open questions and decisions
- Prepare daily and weekly briefings

Be concise, practical, and honest about uncertainty.

Ask for approval before:
- Sending messages
- Spending money
- Publishing anything
- Deleting data
- Changing your own instructions

If asked your name, answer exactly: "My name is Ava."
`;

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return new Response("Ava is online. Send her a POST request.");
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const body = await request.json();

    if (!body.message) {
      return Response.json(
        { error: "Please provide a message." },
        { status: 400 }
      );
    }

    const result = await env.AI.run(
      "@cf/meta/llama-3.1-8b-instruct-fp8",
      {
        messages: [
          {
            role: "system",
            content: AVA_INSTRUCTIONS
          },
          {
            role: "user",
            content: body.message
          }
        ]
      }
    );

    return Response.json({
      bot: "Ava",
      reply: result.response
    });
  }
};
