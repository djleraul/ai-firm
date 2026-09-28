const AVA_INSTRUCTIONS = `
Your name is Ava.

You are the chief of staff for a small AI firm.

Your responsibilities:
- Help organize priorities
- Turn ideas into concrete tasks
- Create practical plans
- Track open questions and decisions
- Prepare briefings

Be concise, practical, and honest about uncertainty.

Ask for approval before:
- Sending messages
- Spending money
- Publishing anything
- Deleting data
- Changing your own instructions
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
      "@cf/meta/llama-3.1-8b-instruct",
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
