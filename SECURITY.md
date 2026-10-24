# 密钥与公开仓库

## Cloudflare Workers Secrets

生产环境的 `GROQ_API_KEYS`、`DASHSCOPE_API_KEYS`、`ZHIPU_API_KEYS` 使用 Workers Secrets，不写入源码、`wrangler.toml`、前端或普通 KV 缓存。

在 `cf-agent` 目录使用交互式输入（不要把密钥直接写在命令行中）：

```sh
npx wrangler secret put GROQ_API_KEYS
npx wrangler secret put DASHSCOPE_API_KEYS
npx wrangler secret put ZHIPU_API_KEYS
npx wrangler secret list
```

只配置使用的供应商；多把密钥以空白或逗号分隔。`secret list` 仅显示名称，不返回密钥值。常规代码部署保留已有 Secrets，首次部署自己的 Worker 时需要自行配置。

本地开发请根据根目录 `.env.example` 创建 `cf-agent/.dev.vars`，仅填自己的密钥。不要覆盖已有本地文件。`.dev.vars`、`.env`、依赖、测试产物及缓存已忽略；不要用 `git add -f` 提交它们。

## 部署配置不是凭据

`cf-agent/wrangler.toml` 中的域名、D1 database ID、KV namespace ID 是部署资源标识，不提供账户访问权限。Fork 后应创建自己的 D1/KV，并替换资源标识及路由，不能直接使用本项目的生产资源。

自动部署使用 GitHub Actions Secrets 中的 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。令牌应限定账户和所需资源；禁止将令牌写入 workflow 或输出日志。模型密钥保留在 Workers Secrets 中，无需复制到 Actions。

## 公开前检查

除工作区外，也要扫描所有分支和 Git 历史。删除当前文件并不会从历史中删除旧凭据。若发现真实泄露，应先撤销/轮换，再清理历史与相关远端引用。

`docs/参考资料/*.html` 是第三方公开网页快照，含网页表单脚本和公开遥测标识，通用密钥扫描器可能告警；这些不是本项目的模型密钥。每次新增告警仍需单独核实，不应对整个目录禁用扫描。

发现安全问题时，请勿在公开 Issue 中粘贴真实密钥、用户问题或账户信息。
