"""Synthetic HTTP requests against a fresh mock service, never a running model."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from serve.frontend import ChatTemplate, openai_to_messages
from serve.server import ByteTokenizer, MockEngine, Service, serve


class CountTokens(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tok = ByteTokenizer()
        cls.engine = MockEngine(tok, "Synthetic answer", max_context=65536)
        cls.svc = Service(cls.engine, tok, ChatTemplate(Path(__file__).resolve().parents[1] / "serve/chat_template.jinja"))
        cls.httpd = serve(cls.svc, port=0)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def count(self, body, headers=None):
        request = urllib.request.Request(self.base + "/v1/chat/completions/count_tokens",
            data=json.dumps(body).encode(), headers={"Content-Type": "application/json", **(headers or {})})
        with patch.object(self.engine, "generate", side_effect=AssertionError("must not run inference")), \
             patch.object(self.svc, "begin_request", side_effect=AssertionError("must not capture count requests")), \
             patch.object(self.svc, "encode_prompt", wraps=self.svc.encode_prompt) as encode:
            with urllib.request.urlopen(request, timeout=10) as response:
                result = json.load(response)
            self.assertFalse(encode.call_args.kwargs["store"], "count must not populate the prompt cache")
            return result

    def test_exact_template_count_for_korean_and_thinking(self):
        for effort in ("none", "low", "high"):
            body = {"messages": [{"role": "user", "content": "자체 생성: 도서관 모임은 18:40 😀"}], "reasoning_effort": effort}
            messages, tools, kw = openai_to_messages(self.svc.with_shared(body, "openai"))
            expected = len(self.svc.encode_prompt(messages, tools, kw, store=False))
            self.assertEqual(self.count(body), {"input_tokens": expected})

    def test_tool_schema_and_result_are_counted(self):
        body = {"messages": [{"role": "user", "content": "Synthetic lookup"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "t", "type": "function",
                "function": {"name": "lookup", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "t", "content": "Synthetic result"},
            {"role": "user", "content": "Next"}],
            "tools": [{"type": "function", "function": {"name": "lookup", "parameters": {"type": "object", "properties": {}}}}]}
        messages, tools, kw = openai_to_messages(self.svc.with_shared(body, "openai"))
        self.assertEqual(self.count(body)["input_tokens"], len(self.svc.encode_prompt(messages, tools, kw, store=False)))

    def test_mcp_tools_counted_for_same_origin_only(self):
        tool = {"name": "synthetic_tool", "description": "Synthetic schema", "parameters": {"type": "object"}}
        hub = SimpleNamespace(wait=Mock(), template_tools=Mock(return_value=[tool]))
        body = {"messages": [{"role": "user", "content": "Synthetic"}], "strata_mcp": True}
        with patch.object(self.svc, "mcp", hub):
            result = self.count(body, {"Origin": self.base})
            messages, _, kw = openai_to_messages(self.svc.with_shared(body, "openai"))
            self.assertEqual(result["input_tokens"], len(self.svc.encode_prompt(messages, [tool], kw, store=False)))
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.count(body, {"Origin": "http://foreign.invalid"})
            self.assertEqual(caught.exception.code, 403)
            caught.exception.close()

    def test_count_matches_mock_generation_usage_with_shared_thinking(self):
        body = {"messages": [{"role": "user", "content": "Synthetic shared setting test"}], "max_tokens": 32}
        with patch.object(self.svc, "shared", {"reasoning_effort": "low"}):
            count = self.count(body)["input_tokens"]
            request = urllib.request.Request(self.base + "/v1/chat/completions", data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=10) as response:
                actual = json.load(response)
            self.assertEqual(count, actual["usage"]["prompt_tokens"])

    def test_count_requires_the_configured_api_key(self):
        body = {"messages": [{"role": "user", "content": "Synthetic auth test"}]}
        with patch.object(self.svc, "api_key", "synthetic-test-key"):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.count(body)
            self.assertEqual(caught.exception.code, 401)
            caught.exception.close()
            self.assertGreater(self.count(body, {"Authorization": "Bearer synthetic-test-key"})["input_tokens"], 0)

    def test_images_rejected_without_encoding_or_fetching(self):
        body = {"messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "https://invalid.example/never-fetch.png"}}]}]}
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.count(body)
        self.assertEqual(caught.exception.code, 400)
        self.assertIn("text only", caught.exception.read().decode())
        caught.exception.close()

    def test_unsupported_prompt_modifiers_are_rejected(self):
        for modifier in ({"response_format": {"type": "json_object"}}, {"tool_choice": "required"}):
            with self.assertRaises(urllib.error.HTTPError) as caught:
                self.count({"messages": [{"role": "user", "content": "Synthetic"}], **modifier})
            self.assertEqual(caught.exception.code, 400)
            self.assertIn("does not support", caught.exception.read().decode())
            caught.exception.close()


if __name__ == "__main__":
    unittest.main()
