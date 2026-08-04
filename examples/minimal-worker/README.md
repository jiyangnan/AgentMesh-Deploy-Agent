# Minimal Worker 产品示例

这是一个无运行时依赖的 Cloudflare Worker 形态产品，用于观察 AgentMesh Deploy 如何分析普通产品仓库。
示例的 `build` 命令只检查语法，`deploy` 命令只输出演示 URL，不会连接 Cloudflare 或创建资源。

先把示例复制成独立 Git 仓库，再交给 Deploy Agent：

```bash
product_dir="$(mktemp -d)"
cp -R examples/minimal-worker/. "$product_dir/"
git -C "$product_dir" init
git -C "$product_dir" add .
git -C "$product_dir" commit -m "chore: initialize worker example"

agentmesh-deploy project add \
  --repo "$product_dir" \
  --id minimal-worker \
  --name "Minimal Worker" \
  --json
agentmesh-deploy analyze minimal-worker --json
```

上述流程只注册和分析锁定 Commit。任何真实供应商访问仍需要 Connection、Sandbox Profile、Approval、
Preflight 以及对应的网络和 Mutation 授权。
