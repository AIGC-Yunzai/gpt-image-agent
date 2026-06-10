# GPT 图像代理插件
这是一款 **Personal Codex** 插件，可通过 MCP 协议调用 GPT Image 2 相关工具。

## 环境配置
1. 在 `config/config.json` 文件中配置接口密钥，配置示例如下：
```json
{
  "baseUrl": "你的接口基础地址",
  "apiKey": "你的接口密钥"
}
```
2. 可在 `config/config.json` 中修改**接口基础地址**、**文件输出目录**、默认参数以及可选的**代理地址**。若未填写 `apiKey`，程序会自动读取环境变量 `MISAKA_GPT_IMAGE_API_KEY` 作为备用密钥。

## 可用工具
- `generate_image`：文生图功能
- `generate_image_batch`：批量文生图任务，支持并发数限制
- `edit_image`：编辑本地图片文件，支持蒙版编辑

所有生成/编辑后的文件都会保存至 `outputDir` 目录，调用结果会返回文件绝对路径。

## 额外配置（codex config.toml）
请在 codex 的 `config.toml`（TOML 格式配置文件）中添加以下内容，**推荐使用 cc-switch 工具编辑该配置文件**：
```toml
[mcp_servers.gpt_image_agent]
command = "node"
args = ['C:\Users\misak\plugins\gpt-image-agent\server\index.mjs']
```