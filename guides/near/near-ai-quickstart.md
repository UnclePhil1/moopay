> ## Documentation Index
> Fetch the complete documentation index at: https://docs.near.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# Quickstart

[NEAR AI Cloud](https://cloud.near.ai) offers developers access to secure, private, verifiable AI models through a unified API. This quickstart guide will walk you through creating an account and making your first requests in minutes.

## Setup

1. **Create your account** - Sign up at [cloud.near.ai](https://cloud.near.ai/)
2. **Add Credits** - Go to the "Credits" section and purchase credits based on your needs
3. **Generate API Key** - Go to the "API Keys" section and generate a new key

> [!TIP]
>
> **Keep Your API Key Safe**
>
> Never share your API key publicly or commit it to version control. If compromised, you can regenerate it anytime from your dashboard.

***

## Make Your First API Call

NEAR AI Cloud uses an OpenAI-compatible API, making it easy to integrate with existing tools and libraries. Connect through the NEAR AI Cloud Gateway at `cloud-api.near.ai`.

> [!NOTE]
>
> Replace `YOUR_API_KEY` with the API key you generated in the setup steps above.

> [!TIP]
>
> **Request IDs**
>
> Gateway responses include an `X-Request-Id` response header. Support may ask you for it when debugging a request. The value is opaque support/debugging metadata, not W3C `traceparent` or distributed trace context. If you send your own `X-Request-Id`, use a non-sensitive UUID value; `X-Request-Id` values must not contain secrets or PII. `X-Org-Id` and `X-Workspace-Id` are internal tenant headers; public clients cannot set or override them.

The gateway routes your request to the appropriate model TEE:

**curl**

```bash theme={"dark"}
curl https://cloud-api.near.ai/v1/chat/completions \
-H "Content-Type: application/json" \
-H "Authorization: Bearer YOUR_API_KEY" \
-d '{
    "model": "zai-org/GLM-5.1-FP8",
    "messages": [{
        "role": "user",
        "content": "Hello, NEAR AI!"
    }]
}'
```

**Python**

```python theme={"dark"}
import openai

client = openai.OpenAI(
    base_url="https://cloud-api.near.ai/v1",
    api_key="YOUR_API_KEY"
)

response = client.chat.completions.create(
    model="zai-org/GLM-5.1-FP8",
    messages=[{
        "role": "user", "content": "Hello, NEAR AI!"
    }]
)

print(response.choices[0].message.content)
```

**JavaScript**

```javascript theme={"dark"}
import OpenAI from 'openai';

const openai = new OpenAI({
    baseURL: 'https://cloud-api.near.ai/v1',
    apiKey: 'YOUR_API_KEY',
});

const completion = await openai.chat.completions.create({
    model: 'zai-org/GLM-5.1-FP8',
    messages: [{
        role: 'user', content: 'Hello, NEAR AI!'
    }]
});

console.log(completion.choices[0].message.content);
```

### Expected Response

The API will return a JSON response containing the model's completion:

```json theme={"dark"}
{
  "id": "f47b4647911249f7a94468f6c2b95832",
  "object": "chat.completion",
  "created": 1780405025,
  "model": "zai-org/GLM-5.1-FP8",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello there! 👋 Welcome to NEAR AI! I'm here to help you with whatever you need — whether it's answering questions, brainstorming ideas, writing code, or just having a conversation. How can I assist you today?",
      "reasoning_content": "The user is greeting me. I should respond warmly and introduce myself as a NEAR AI assistant."
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 11,
    "completion_tokens": 70,
    "completion_tokens_details": {
      "reasoning_tokens": 21
    },
    "reasoning_tokens": 21,
    "total_tokens": 81
  }
}
```

> [!NOTE]
>
> `zai-org/GLM-5.1-FP8` is a reasoning model, so the response includes a `reasoning_content` field and the reasoning token count in `usage.completion_tokens_details.reasoning_tokens` (the top-level `reasoning_tokens` is a deprecated alias). See [Reasoning Models](https://docs.near.ai/cloud/reasoning-models.md) to control this behavior.

All inference is performed within Trusted Execution Environments (TEEs), ensuring your data remains private and verifiable.

> [!TIP]
>
> **Using OpenAI SDKs?**
>
> For streaming, async operations, and the stateless Responses API, see our comprehensive [OpenAI Compatibility Guide](https://docs.near.ai/cloud/guides/openai-compatibility.md).

***

## Next Steps

> **[Explore Models](https://docs.near.ai/cloud/models.md)**
>
> Browse available AI models including GLM, Qwen, OpenAI, Anthropic, and Gemini

> **[Private Inference](https://docs.near.ai/cloud/private-inference.md)**
>
> Learn about the secure architecture and how your data is protected

> **[Verification](https://docs.near.ai/cloud/verification)**
>
> Understand how to verify and validate secure interactions with AI models

> **[OpenAI Compatibility](https://docs.near.ai/cloud/guides/openai-compatibility.md)**
>
> Use standard OpenAI SDKs with streaming, async, and stateless Responses


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.