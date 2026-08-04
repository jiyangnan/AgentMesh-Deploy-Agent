# 隔离 SaaS 产品示例

这个目录模拟一个包含 Node.js 服务、PostgreSQL 迁移、事务邮件变量和静态前端的 SaaS 产品。它用于展示
AgentMesh Deploy 如何把产品仓库当作只读输入，并把计划、审批、状态和证据保存在外部 Control Home。

先复制并提交为独立产品仓库：

```bash
product_dir="$(mktemp -d)"
cp -R examples/isolated-saas/. "$product_dir/"
git -C "$product_dir" init
git -C "$product_dir" add .
git -C "$product_dir" commit -m "chore: initialize SaaS example"

agentmesh-deploy project add \
  --repo "$product_dir" \
  --id isolated-saas \
  --name "Isolated SaaS" \
  --json
agentmesh-deploy analyze isolated-saas --json
agentmesh-deploy first-launch start isolated-saas \
  --owner product-owner \
  --deadline 2027-01-01T00:00:00.000Z \
  --secret-backend keychain \
  --json
```

这些命令不会调用真实供应商。后续 Agent 必须根据 JSON 返回的 `nextActions` 完成供应商选择、Secret Ref、
预算和 Sandbox 审批，不能把示例环境与任何现有产品资源混用。
