# llama.cpp b10182 — third-party notice

Switchboard’s macOS arm64 runtime pipeline uses the official `llama.cpp`
`b10182` release archive as a pinned source input. The archive is not checked
into this repository. Distribution remains blocked until the complete payload
is Switchboard-signed, notarized with the outer application, and passes its
native smoke test.

- Project: `ggml-org/llama.cpp`
- Source: <https://github.com/ggml-org/llama.cpp>
- Pinned tag: `b10182`
- Pinned commit: `afeebe103bd99cda8f5dfaefcabadf890db7fda7`
- License: MIT

The upstream archive contains the following license notice, which must remain
in every distributed payload:

```text
MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Model weights have separate licenses and are not covered by this notice.
