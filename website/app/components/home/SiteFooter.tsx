import { Link } from "react-router-dom";
import { useT } from "../../lib/i18n";

/* 官网 Footer。只展示仓库中真实存在的信息与路由。
   不生成公司地址、电话、邮箱、ICP、社交账号、客户数量或服务年限。
   没有独立页面的能力项指向首页真实 Section 锚点；实时监控使用已上线公开路由。 */

export function SiteFooter() {
  const t = useT();
  return (
    <footer className="home-footer">
      <div className="home-wrap">
        <div className="home-footer-inner">
          <div className="home-footer-brand">
            <span className="home-brand">
              <span className="home-brand-mark" role="img" aria-label={t.common.brand} />
            </span>
            <p>{t.footer.tagline}</p>
          </div>

          <div className="home-footer-links">
            <div className="home-footer-col">
              <b>{t.footer.servicesTitle}</b>
              <Link to="/subscribe">{t.footer.plans}</Link>
              <Link to="/diagnosis">{t.footer.diagnosis}</Link>
              <Link to="/monitor">{t.footer.monitor}</Link>
            </div>
            <div className="home-footer-col">
              <b>{t.footer.accountTitle}</b>
              <Link to="/login">{t.footer.login}</Link>
              <Link to="/register">{t.footer.register}</Link>
              <Link to="/dashboard">{t.footer.customerCenter}</Link>
            </div>
          </div>
        </div>

        <div className="home-footer-bar">
          <span>{t.footer.bar}</span>
        </div>
      </div>
    </footer>
  );
}
