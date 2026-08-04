# 安全策略

## 报告安全问题

请通过 GitHub 的 Private Vulnerability Reporting 提交安全问题，不要在公开 Issue 中披露 Token、
供应商账号、域名控制证据、数据库连接信息或可复现的生产攻击细节。

## 支持范围

当前维护版本为最新 GitHub Release。安全修复会发布新版本，不会覆盖或移动既有 Git Tag。

## 凭证处理

AgentMesh Deploy 只应持久化 Secret Ref。任何供应商 Token、数据库 URI、SSH 私钥或一次性凭证都必须
通过运行时 Secret Store 解析，并且不得进入 Git、Plan、State、Run、Receipt、Evidence 或日志。

## 高风险操作

供应商网络访问、资源 Mutation、费用、删除、数据库破坏性操作和生产切流必须保持独立授权。发现绕过
这些门槛、跨项目接管资源、重复执行不确定 Mutation 或修改产品仓库的行为，请按安全漏洞报告。
