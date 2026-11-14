/**
 * ==========================================================================
 * ARROWTECH - CONFIGURAÇÃO CENTRAL DO SITE (assets/js/data.js)
 * Gerenciado pelo Software de Configuração ArrowTech (configurador.html / .bat)
 * ==========================================================================
 */

/* __ARROWTECH_CONFIG_START__ */
window.ARROWTECH_FILE_CONFIG = {"updatedAt":1794683321306,"storeName":"ArrowTech","whatsappNumber":"5511915364181","whatsappDisplay":"(11) 91536-4181","whatsappDefaultMsg":"Olá! Vim pelo site da ArrowTech e quero fazer um orçamento.","instagramHandle":"@_arrowtech","instagramUrl":"https://instagram.com/_arrowtech","warrantyText":"3 Meses de Garantia","gift1":"Limpeza Completa","gift2":"Par de Grips Protetores","bannerEnabled":false,"bannerText":"🔥 Promoção da Semana: Frete/Coleta com condições especiais pelo WhatsApp!","prices":{"xbox_orig_unit":55,"xbox_orig_pair":110,"xbox_hall_unit":75,"xbox_hall_pair":140,"xbox_tmr_unit":90,"xbox_tmr_pair":160,"ps5_orig_unit":60,"ps5_orig_pair":115,"ps5_hall_unit":80,"ps5_hall_pair":150,"ps5_tmr_unit":99,"ps5_tmr_pair":179}};
/* __ARROWTECH_CONFIG_END__ */

(function () {
  'use strict';

  const STORAGE_KEY = 'ARROWTECH_SITE_CONFIG';

  function loadEffectiveConfig() {
    const fileCfg = window.ARROWTECH_FILE_CONFIG || {};
    let localCfg = null;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        localCfg = JSON.parse(raw);
      }
    } catch (e) {
      // Ignora erro de localStorage em contextos restritos
    }

    // Usa o que for mais recente entre o arquivo físico (data.js) e o localStorage
    if (localCfg && (localCfg.updatedAt || 0) >= (fileCfg.updatedAt || 0)) {
      return Object.assign({}, fileCfg, localCfg, {
        prices: Object.assign({}, fileCfg.prices || {}, localCfg.prices || {}),
        extraLinks: Object.assign({}, fileCfg.extraLinks || {}, localCfg.extraLinks || {})
      });
    }
    return fileCfg;
  }

  window.ARROWTECH_CONFIG = loadEffectiveConfig();

  window.applyArrowTechConfig = function () {
    const cfg = loadEffectiveConfig();
    window.ARROWTECH_CONFIG = cfg;
    if (!cfg) return;

    const cleanPhone = String(cfg.whatsappNumber || '5511999999999').replace(/\D/g, '');
    const igUrl = cfg.instagramUrl || 'https://instagram.com/arrowtech.games';
    const igHandle = cfg.instagramHandle || '@arrowtech.games';

    // 1. Atualiza todos os links de WhatsApp (preservando mensagens específicas de cada botão)
    document.querySelectorAll('a[href*="wa.me/"]').forEach((link) => {
      link.href = link.href.replace(/wa\.me\/\d+/, `wa.me/${cleanPhone}`);
    });

    // 2. Atualiza todos os links de Instagram
    document.querySelectorAll('a[href*="instagram.com/"]').forEach((link) => {
      link.href = igUrl;
    });

    // 3. Atualiza textos vinculados do Instagram e Garantia/Brindes
    document.querySelectorAll('[data-config="instagram-handle"]').forEach((el) => {
      el.textContent = igHandle;
    });
    document.querySelectorAll('[data-config="instagram-cta-text"]').forEach((el) => {
      el.textContent = `Ver Instagram ${igHandle}`;
    });
    if (cfg.warrantyText) {
      document.querySelectorAll('[data-config="warranty-text"]').forEach((el) => {
        el.textContent = cfg.warrantyText;
      });
    }
    if (cfg.gift1) {
      document.querySelectorAll('[data-config="gift-1"]').forEach((el) => {
        el.textContent = cfg.gift1;
      });
    }
    if (cfg.gift2) {
      document.querySelectorAll('[data-config="gift-2"]').forEach((el) => {
        el.textContent = cfg.gift2;
      });
    }
    if (cfg.whatsappDisplay) {
      document.querySelectorAll('[data-config="whatsapp-display-tag"]').forEach((el) => {
        el.textContent = `Atendimento Imediato • ${cfg.whatsappDisplay}`;
      });
    }

    // 4. Atualiza tabela de preços (Manutenção)
    if (cfg.prices) {
      Object.keys(cfg.prices).forEach((key) => {
        const val = cfg.prices[key];
        if (val === undefined || val === null || val === '') return;
        document.querySelectorAll(`[data-price="${key}"]`).forEach((el) => {
          if (key.endsWith('_pair')) {
            el.textContent = `Par: R$ ${val}`;
          } else {
            el.textContent = `R$ ${val}`;
          }
        });
      });
    }

    // 5. Banner opcional de Aviso / Promoção no topo do site
    let topBanner = document.getElementById('arrowtech-dynamic-banner');
    if (cfg.bannerEnabled && cfg.bannerText) {
      if (!topBanner && !window.location.pathname.includes('configurador')) {
        topBanner = document.createElement('div');
        topBanner.id = 'arrowtech-dynamic-banner';
        topBanner.className = 'bg-gradient-to-r from-cyan-500/20 via-blue-600/25 to-cyan-500/20 border-b border-cyan-400/30 text-cyan-200 text-xs font-bold text-center py-2 px-4 mt-20';
        const header = document.getElementById('main-header');
        if (header && header.parentNode) {
          header.parentNode.insertBefore(topBanner, header.nextSibling);
          const mainEl = document.querySelector('main');
          if (mainEl) {
            mainEl.classList.remove('pt-24', 'pt-28');
            mainEl.classList.add('pt-6');
          }
        }
      }
      if (topBanner) {
        topBanner.textContent = cfg.bannerText;
      }
    } else if (topBanner) {
      topBanner.remove();
    }
  };

  // Sincroniza em tempo real caso o configurador esteja aberto em outra aba/janela
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      window.applyArrowTechConfig();
    }
  });

  document.addEventListener('DOMContentLoaded', () => {
    window.applyArrowTechConfig();
  });
})();
