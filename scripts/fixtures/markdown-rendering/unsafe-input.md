# 不安全输入基线

[脚本协议](javascript:alert('unsafe-link'))

[未知协议](trellora-unsafe://payload)

<img src="javascript:alert('unsafe-image')" alt="脚本图片" onerror="window.fixtureCompromised = true">

<script>window.fixtureCompromised = true</script>

<iframe src="https://example.com/embedded"></iframe>

<form action="https://example.com/collect"><input name="secret"></form>

![越界路径](../../outside.png)

```mermaid
BROKEN_MERMAID {
```
