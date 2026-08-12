# GPT 图像代理插件
- 这是一款 **Personal Codex** 插件，可通过 MCP 协议调用 GPT Image 2 相关工具
- 使用 OpenAI API 绘画接口接入个人 gpt-image-2 站点
- 适用场景：1. 节约官Key Token；2. 某些无 gpt image 2 工具的公益站。

### 预览
<img width="1402" height="842" alt="image" src="https://github.com/user-attachments/assets/587a86e6-07a4-433a-ad0a-7ce6b1d892b6" />

## 安装方式

- 推荐直接给本仓库地址给 Codex 让它帮你安装
- 或使用 cc-switch 工具安装

## 环境配置（必须）
1. 将 `config/config.example.json` 复制为 `config/config.json` 并配置，必须配置示例如下：
```json
{
  "baseUrl": "你的接口基础地址，通常以 /v1 结尾",
  "apiKey": "你的接口密钥"
}
```

1. （可选）可在 `config/config.json` 中修改**文件输出目录**、默认参数以及可选的**代理地址**。`outputDir` 支持 `~`（例如 `~/.codex/generated_images/gpt-image-2-output`），会自动展开为当前用户主目录；Windows 也可以直接填入可写绝对路径，例如 `C:\Users\你的用户名\Pictures\gpt-image-output`。

## Codex 配置（必须）
请在 codex 的 `config.toml`（TOML 格式配置文件）中添加以下内容，其中 `args` 的具体路径取决于你安装地址，**推荐使用 cc-switch 工具编辑该配置文件**：
```toml
[mcp_servers.gpt_image_agent]
command = "node"
args = ['C:\Users\{{用户名}}\plugins\misaka-gpt-image-agent\server\index.mjs']
```

注意：配置完成后需要重启 codex 生效

## 可用工具
- `generate_image`：文生图功能
- `generate_image_batch`：批量文生图任务，支持并发数限制
- `edit_image`：编辑本地图片文件，支持蒙版编辑

所有生成/编辑后的文件都会保存至 `outputDir` 目录，调用结果会返回文件绝对路径。生成和编辑可能需要数分钟；插件 MCP 配置已将单次工具调用超时设为 600 秒。

### 为单次任务指定可写输出目录

每次调用工具时都应传入 `outputDir`，将图片直接保存到用户希望使用的工作/项目目录，无需临时修改 `config/config.json`：

```json
{
  "prompt": "一只戴红色围巾的猫",
  "outputName": "scarf-cat",
  "outputDir": "C:\\work\\my-project\\assets\\generated"
}
```

- `generate_image` 和 `edit_image` 的 `outputDir` 仅影响本次调用；未指定输出位置时，LLM 应使用当前任务工作目录的绝对路径。
- `generate_image_batch` 在**顶层**传入一个 `outputDir`，该批次所有任务写入同一目录；不要在单个 `jobs` 项内传入。
- 优先直接调用 Codex 已注册的 `misaka-gpt-image-agent` MCP 工具，不要自行编写 Node MCP 客户端或临时改写配置文件。
