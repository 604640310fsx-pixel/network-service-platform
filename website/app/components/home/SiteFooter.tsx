import { Link } from "react-router-dom";

/* 官网 Footer。只展示仓库中真实存在的信息与路由。
   不生成公司地址、电话、邮箱、ICP、社交账号、客户数量或服务年限。
   没有独立页面的能力项指向首页真实 Section 锚点；实时监控使用已上线公开路由。 */

export function SiteFooter() {
  return (
    <footer className="home-footer">
      <div className="home-wrap">
        <div className="home-footer-inner">
          <div className="home-footer-brand">
            <span className="home-brand">
              <span className="home-brand-mark" role="img" aria-label="Drink Life" />
            </span>
            <p>跨境网络环境诊断与交付。先判断问题在哪里，再决定是否需要优化或更换方案。</p>
          </div>

          <div className="home-footer-links">
            <div className="home-footer-col">
              <b>服务</b>
              <Link to="/subscribe">网络方案</Link>
              <Link to="/diagnosis">诊断服务</Link>
              <Link to="/monitor">实时监控</Link>
            </div>
            <div className="home-footer-col">
              <b>账户</b>
              <Link to="/login">登录</Link>
              <Link to="/register">注册</Link>
              <Link to="/dashboard">客户中心</Link>
            </div>
          </div>
        </div>

        <div className="home-footer-bar">
          <span>网络服务平台</span>
        </div>
      </div>
    </footer>
  );
}
