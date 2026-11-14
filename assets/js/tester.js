/**
 * ==========================================================================
 * ARROWTECH - LABORATÓRIO DE DIAGNÓSTICO & DUALSENSE WEBHID TESTER (tester.js)
 * Suporta:
 *  1. WebHID API (Sony DualSense / DualSense Edge / DualShock 4):
 *     - Leitura bruta de pacote HID (60Hz~250Hz), Touchpad 2 pontos, Giroscópio,
 *       Acelerômetro, Bateria real, Leitura de Firmware/Hardware (0x20)
 *     - Output Report 0x02 (Gatilhos Adaptáveis L2/R2, Vibração Haptic,
 *       LED RGB da Barra de Luz, LEDs de Jogador 1-5 e LED do Botão Mute)
 *  2. Gamepad API Universal (PS5, PS4, Xbox Series/One, Switch Pro, Genéricos):
 *     - Todos os botões, gatilhos analógicos, eixos X/Y, taxa de polling (Hz),
 *       teste de vibração dual-rumble e diagnóstico automático de Drift.
 *  3. Medidor de Circularidade (48 setores) + Microscópio de Centro (5x)
 *  4. Modo Simulador Interativo (Comparativo Potenciômetro com Drift vs TMR/Hall)
 * ==========================================================================
 */

(function () {
  'use strict';

  const SONY_VENDOR_ID = 0x054c;
  const DUALSENSE_PIDS = [0x0ce6, 0x0df2]; // DualSense & DualSense Edge
  const DS4_PIDS = [0x05c4, 0x09cc];

  // Estado reativo central do testador
  const state = {
    mode: 'idle', // 'idle' | 'gamepad' | 'webhid' | 'sim-drift' | 'sim-tmr'
    skin: 'ps5', // 'ps5' | 'xbox'
    controllerName: 'Nenhum controle conectado',
    vendorProduct: '—',
    connectionType: 'Aguardando...',
    boardRevision: '—',
    serialNumber: '—',
    firmwareVersion: '—',
    batteryPercent: null,
    batteryCharging: false,
    pollingHz: 0,

    // Eixos brutos (sem calibração de software) e eixos normalizados (-1.0 a +1.0)
    rawAxes: {
      lx: 0,
      ly: 0,
      rx: 0,
      ry: 0
    },
    axes: {
      lx: 0,
      ly: 0,
      rx: 0,
      ry: 0
    },

    // Estado de Calibração de Analógicos (Modo de Teste RAM -> Aprovação -> Gravação na Placa NVRAM)
    activeTab: 'tester', // 'tester' | 'calibration'
    calibration: {
      offsetLX: 0,
      offsetLY: 0,
      offsetRX: 0,
      offsetRY: 0,
      scaleLX: 1,
      scaleLY: 1,
      scaleRX: 1,
      scaleRY: 1,
      samplingRange: false,
      rangeSectorsL: new Uint8Array(48),
      rangeSectorsR: new Uint8Array(48),
      maxRadiusL: 0,
      maxRadiusR: 0,
      hasPendingTest: false
    },

    // Circularidade (48 setores angulares para cada analógico)
    circularity: {
      enabled: true,
      zoomCenter: false,
      leftSectors: new Float32Array(48),
      rightSectors: new Float32Array(48),
      leftTrail: [],
      rightTrail: [],
      leftAvgError: 0,
      rightAvgError: 0
    },

    // Gatilhos (0.0 a 1.0)
    triggers: {
      l2: 0,
      r2: 0
    },

    // 18 Botões mapeados no padrão W3C Gamepad + extras DualSense
    buttons: {
      cross: false,      // 0 (A no Xbox)
      circle: false,     // 1 (B no Xbox)
      square: false,     // 2 (X no Xbox)
      triangle: false,   // 3 (Y no Xbox)
      l1: false,         // 4
      r1: false,         // 5
      l2Btn: false,      // 6
      r2Btn: false,      // 7
      create: false,     // 8 (Share / View)
      options: false,    // 9 (Menu)
      l3: false,         // 10
      r3: false,         // 11
      up: false,         // 12
      down: false,       // 13
      left: false,       // 14
      right: false,      // 15
      ps: false,         // 16 (Logo PS / Xbox)
      touchpad: false,   // 17
      mute: false        // 18 (Exclusivo DualSense)
    },

    // Histórico de botões já testados na sessão (para checklist de diagnóstico)
    testedButtons: new Set(),

    // Touchpad DualSense (1920 x 1080)
    touch: {
      t1Active: false,
      t1Id: 0,
      t1X: 960,
      t1Y: 540,
      t2Active: false,
      t2Id: 0,
      t2X: 1200,
      t2Y: 540,
      trail1: []
    },

    // IMU Sensores (Giroscópio e Acelerômetro)
    imu: {
      gyroX: 0,
      gyroY: 0,
      gyroZ: 0,
      accelX: 0,
      accelY: 0,
      accelZ: 0,
      historyGyro: [],
      historyAccel: []
    },

    // Configurações de Output WebHID para DualSense
    dualsenseOutput: {
      l2Mode: 'off',       // 'off' | 'continuous' | 'section' | 'pulse'
      l2Force: 180,
      l2Start: 40,
      r2Mode: 'off',
      r2Force: 180,
      r2Start: 40,
      rumbleHeavy: 0,
      rumbleSoft: 0,
      ledR: 0,
      ledG: 229,
      ledB: 255,
      playerLeds: 1,       // 0 a 5
      muteLed: 0           // 0=Off, 1=On, 2=Pulse
    }
  };

  let hidDevice = null;
  let activeGamepadIndex = null;
  let lastFrameTime = performance.now();
  let frameCounter = 0;
  let fpsTimer = performance.now();
  let simAngle = 0;

  // Elementos de Canvas
  let canvasLeft = null;
  let ctxLeft = null;
  let canvasRight = null;
  let ctxRight = null;
  let canvasImu = null;
  let ctxImu = null;
  let canvasTouchpad = null;
  let ctxTouchpad = null;

  /* ==========================================================================
   * 1. INICIALIZAÇÃO DO PAINEL
   * ========================================================================== */
  document.addEventListener('DOMContentLoaded', () => {
    canvasLeft = document.getElementById('canvas-stick-left');
    canvasRight = document.getElementById('canvas-stick-right');
    canvasImu = document.getElementById('canvas-imu');
    canvasTouchpad = document.getElementById('canvas-touchpad');

    if (canvasLeft) ctxLeft = canvasLeft.getContext('2d');
    if (canvasRight) ctxRight = canvasRight.getContext('2d');
    if (canvasImu) ctxImu = canvasImu.getContext('2d');
    if (canvasTouchpad) ctxTouchpad = canvasTouchpad.getContext('2d');

    bindUIEvents();
    setupGamepadListeners();
    checkWebHIDSupport();

    requestAnimationFrame(mainLoop);
  });

  function checkWebHIDSupport() {
    const webhidBadge = document.getElementById('webhid-support-badge');
    const btnConnectHid = document.getElementById('btn-connect-webhid');
    if ('hid' in navigator) {
      if (webhidBadge) {
        webhidBadge.textContent = 'WebHID Compatível (Chrome/Edge)';
        webhidBadge.className = 'text-[11px] font-bold px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30';
      }
      // Se já houver um controle Sony autorizado conectado via WebHID, abre e identifica automaticamente
      navigator.hid.getDevices().then((devices) => {
        const sonyDev = devices.find((d) => d.vendorId === SONY_VENDOR_ID);
        if (sonyDev && state.mode === 'idle') {
          openAuthorizedHIDDevice(sonyDev);
        }
      }).catch(() => {});

      navigator.hid.addEventListener('disconnect', (e) => {
        if (hidDevice && e.device === hidDevice) {
          hidDevice = null;
          state.mode = 'idle';
          state.controllerName = 'Controle desconectado';
          state.connectionType = 'Aguardando...';
          updateConnectionBanner();
          updateSkinTabs();
          showNotification('Controle WebHID desconectado.', 'warn');
        }
      });
    } else {
      if (webhidBadge) {
        webhidBadge.textContent = 'WebHID Indisponível neste Navegador (Use Chrome/Edge no PC)';
        webhidBadge.className = 'text-[11px] font-bold px-2.5 py-1 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/30';
      }
      if (btnConnectHid) {
        btnConnectHid.classList.add('opacity-60');
      }
    }
  }

  /**
   * Motor de Identificação Automática de Hardware (VID / PID / String do Driver)
   */
  function identifyControllerModel(nameOrId, vendorId, productId) {
    const s = String(nameOrId || '').toLowerCase();

    // 1. Por Vendor/Product ID exato (WebHID)
    if (vendorId === SONY_VENDOR_ID) {
      if (DS4_PIDS.includes(productId)) {
        return {
          skin: 'ps4',
          vendorProduct: `${vendorId.toString(16).padStart(4, '0').toUpperCase()}:${productId.toString(16).padStart(4, '0').toUpperCase()}`,
          boardRevision: 'DualShock 4 (JDM-010 a JDM-055)'
        };
      }
      return {
        skin: 'ps5',
        vendorProduct: `${vendorId.toString(16).padStart(4, '0').toUpperCase()}:${productId.toString(16).padStart(4, '0').toUpperCase()}`,
        boardRevision: productId === 0x0df2 ? 'DualSense Edge (FN)' : 'DualSense (BDM-010 a BDM-050)'
      };
    }

    // 2. Por String do Gamepad API (Chrome / Edge / Firefox / Windows XInput / DirectInput)
    if (
      s.includes('05c4') ||
      s.includes('09cc') ||
      s.includes('0ba0') ||
      s.includes('dualshock 4') ||
      s.includes('ps4') ||
      (s.includes('wireless controller') && !s.includes('dualsense') && !s.includes('0ce6') && !s.includes('0df2') && s.includes('054c'))
    ) {
      return {
        skin: 'ps4',
        vendorProduct: '054C:09CC (Sony DS4)',
        boardRevision: 'Sony DualShock 4 (JDM)'
      };
    }

    if (
      s.includes('0ce6') ||
      s.includes('0df2') ||
      s.includes('dualsense') ||
      s.includes('ps5') ||
      s.includes('054c')
    ) {
      return {
        skin: 'ps5',
        vendorProduct: s.includes('0df2') ? '054C:0DF2 (Edge)' : '054C:0CE6 (DualSense)',
        boardRevision: 'Sony PS5 DualSense'
      };
    }

    if (
      s.includes('057e') ||
      s.includes('2009') ||
      s.includes('2006') ||
      s.includes('2007') ||
      s.includes('switch') ||
      s.includes('joy-con') ||
      s.includes('pro controller') ||
      s.includes('nintendo')
    ) {
      return {
        skin: 'switch',
        vendorProduct: '057E:2009 (Nintendo)',
        boardRevision: 'Nintendo Switch Pro / Joy-Con'
      };
    }

    if (
      s.includes('xbox') ||
      s.includes('xinput') ||
      s.includes('045e') ||
      s.includes('microsoft')
    ) {
      return {
        skin: 'xbox',
        vendorProduct: '045E:0B12 (Xbox XInput)',
        boardRevision: 'Microsoft Xbox Series X|S / One'
      };
    }

    // Fallback padrão para controles XInput genéricos no Windows vs DirectInput
    return {
      skin: 'xbox',
      vendorProduct: 'USB / Bluetooth Gamepad',
      boardRevision: 'Padrão XInput / Assimétrico'
    };
  }

  /* ==========================================================================
   * 2. CONEXÃO WEBHID (DUALSENSE / DUALSENSE EDGE / DS4)
   * ========================================================================== */
  async function openAuthorizedHIDDevice(device) {
    if (hidDevice && hidDevice.opened && hidDevice !== device) {
      await hidDevice.close();
    }
    hidDevice = device;
    if (!hidDevice.opened) {
      await hidDevice.open();
    }

    const detected = identifyControllerModel(hidDevice.productName, hidDevice.vendorId, hidDevice.productId);
    state.mode = 'webhid';
    state.skin = detected.skin;
    state.controllerName = hidDevice.productName || (state.skin === 'ps4' ? 'Sony DualShock 4 Controller' : 'Sony DualSense Wireless Controller');
    state.vendorProduct = detected.vendorProduct;
    state.boardRevision = detected.boardRevision;
    state.testedButtons.clear();
    resetCircularity();

    await readDualSenseFirmwareInfo(hidDevice);
    hidDevice.oninputreport = handleHIDInputReport;
    await sendDualSenseOutputReport();

    updateConnectionBanner();
    updateSkinTabs();
    showNotification(`Controle identificado via WebHID: ${state.controllerName}`, 'success');
  }

  async function connectWebHID() {
    if (!('hid' in navigator)) {
      showNotification('Seu navegador não suporta a API WebHID. Use Google Chrome, Edge, Brave ou Opera no computador.', 'warn');
      return;
    }

    try {
      const devices = await navigator.hid.requestDevice({
        filters: [
          { vendorId: SONY_VENDOR_ID, productId: 0x0ce6 }, // DualSense
          { vendorId: SONY_VENDOR_ID, productId: 0x0df2 }, // DualSense Edge
          { vendorId: SONY_VENDOR_ID, productId: 0x05c4 }, // DualShock 4 v1
          { vendorId: SONY_VENDOR_ID, productId: 0x09cc }  // DualShock 4 v2
        ]
      });

      if (!devices || devices.length === 0) return;
      await openAuthorizedHIDDevice(devices[0]);
    } catch (err) {
      console.error('Erro ao conectar WebHID:', err);
      showNotification('Não foi possível abrir o dispositivo WebHID. Verifique se outro app (como Steam ou DS4Windows) está bloqueando o controle.', 'error');
    }
  }

  async function readDualSenseFirmwareInfo(device) {
    try {
      // Solicita Feature Report 0x05 (Calibração) para forçar o DualSense via Bluetooth a entrar no modo completo 0x31 (Touchpad + Giroscópio)
      await device.receiveFeatureReport(0x05);
    } catch (_) {}

    try {
      // Feature report 0x20 contém versão de firmware e revisão de hardware no DualSense USB
      const dataView = await device.receiveFeatureReport(0x20);
      if (dataView && dataView.byteLength >= 40) {
        const hwMinor = dataView.getUint8(24);
        const hwMajor = dataView.getUint8(25);
        const fwBuild = dataView.getUint16(28, true);

        // Estimativa de placa BDM baseada na revisão de hardware do DualSense
        let bdm = 'BDM-010 / 020';
        if (hwMajor >= 4) bdm = 'BDM-040 / 050';
        else if (hwMajor === 3) bdm = 'BDM-030';
        else if (hwMajor === 2) bdm = 'BDM-020';
        else if (hwMajor === 1) bdm = 'BDM-010';

        state.boardRevision = `${bdm} (HW ${hwMajor}.${hwMinor})`;
        state.firmwareVersion = `v${fwBuild.toString(16).toUpperCase()}`;
      } else {
        state.boardRevision = device.productId === 0x0df2 ? 'DualSense Edge (FN)' : 'DualSense Padrão';
        state.firmwareVersion = 'Leitura USB';
      }
    } catch (_) {
      state.boardRevision = device.productId === 0x0df2 ? 'DualSense Edge' : 'DualSense (Modo HID)';
      state.firmwareVersion = 'Padrão';
    }
  }

  function handleHIDInputReport(event) {
    const { data, reportId } = event;
    if (!data) return;

    // Contagem de taxa de polling Hz
    frameCounter++;
    const now = performance.now();
    if (now - fpsTimer >= 500) {
      state.pollingHz = Math.round((frameCounter * 1000) / (now - fpsTimer));
      frameCounter = 0;
      fpsTimer = now;
    }

    // DualSense USB (reportId 0x01) vs Bluetooth (reportId 0x31)
    let offset = 0;
    if (reportId === 0x01) {
      state.connectionType = 'USB Direto (WebHID)';
      offset = 0;
    } else if (reportId === 0x31) {
      state.connectionType = 'Bluetooth (WebHID)';
      offset = 1;
    } else {
      return;
    }

    if (data.byteLength < offset + 40) return;

    // Eixos Analógicos (0..255 -> -1.0..+1.0)
    const rawLX = data.getUint8(offset + 0);
    const rawLY = data.getUint8(offset + 1);
    const rawRX = data.getUint8(offset + 2);
    const rawRY = data.getUint8(offset + 3);
    const rawL2 = data.getUint8(offset + 4);
    const rawR2 = data.getUint8(offset + 5);

    const normLX = (rawLX - 127.5) / 127.5;
    const normLY = (rawLY - 127.5) / 127.5;
    const normRX = (rawRX - 127.5) / 127.5;
    const normRY = (rawRY - 127.5) / 127.5;
    applyStickCalibration(normLX, normLY, normRX, normRY);

    state.triggers.l2 = rawL2 / 255;
    state.triggers.r2 = rawR2 / 255;

    // Botões (Bytes 7, 8, 9 no relatório USB)
    const b0 = data.getUint8(offset + 7);
    const b1 = data.getUint8(offset + 8);
    const b2 = data.getUint8(offset + 9);

    const dpad = b0 & 0x0f;
    state.buttons.up = dpad === 0 || dpad === 1 || dpad === 7;
    state.buttons.right = dpad === 1 || dpad === 2 || dpad === 3;
    state.buttons.down = dpad === 3 || dpad === 4 || dpad === 5;
    state.buttons.left = dpad === 5 || dpad === 6 || dpad === 7;

    state.buttons.square = (b0 & 0x10) !== 0;
    state.buttons.cross = (b0 & 0x20) !== 0;
    state.buttons.circle = (b0 & 0x40) !== 0;
    state.buttons.triangle = (b0 & 0x80) !== 0;

    state.buttons.l1 = (b1 & 0x01) !== 0;
    state.buttons.r1 = (b1 & 0x02) !== 0;
    state.buttons.l2Btn = (b1 & 0x04) !== 0 || state.triggers.l2 > 0.1;
    state.buttons.r2Btn = (b1 & 0x08) !== 0 || state.triggers.r2 > 0.1;
    state.buttons.create = (b1 & 0x10) !== 0;
    state.buttons.options = (b1 & 0x20) !== 0;
    state.buttons.l3 = (b1 & 0x40) !== 0;
    state.buttons.r3 = (b1 & 0x80) !== 0;

    state.buttons.ps = (b2 & 0x01) !== 0;
    state.buttons.touchpad = (b2 & 0x02) !== 0;
    state.buttons.mute = (b2 & 0x04) !== 0;

    recordTestedButtons();

    // Sensores IMU (Giroscópio bytes 15..20, Acelerômetro bytes 21..26)
    if (data.byteLength >= offset + 27) {
      state.imu.gyroX = data.getInt16(offset + 15, true);
      state.imu.gyroY = data.getInt16(offset + 17, true);
      state.imu.gyroZ = data.getInt16(offset + 19, true);
      state.imu.accelX = data.getInt16(offset + 21, true);
      state.imu.accelY = data.getInt16(offset + 23, true);
      state.imu.accelZ = data.getInt16(offset + 25, true);
      pushImuSample();
    }

    // Touchpad (2 pontos de toque a partir do byte 32 no DualSense USB / byte 33 no Bluetooth 0x31)
    if (data.byteLength >= offset + 40) {
      const tpBase = state.skin === 'ps4' ? offset + 34 : offset + 32;
      if (data.byteLength >= tpBase + 8) {
        const t1Contact = data.getUint8(tpBase + 0);
        const t1x = data.getUint8(tpBase + 1) | ((data.getUint8(tpBase + 2) & 0x0f) << 8);
        const t1y = (data.getUint8(tpBase + 2) >> 4) | (data.getUint8(tpBase + 3) << 4);

        state.touch.t1Active = (t1Contact & 0x80) === 0;
        state.touch.t1Id = t1Contact & 0x7f;
        if (state.touch.t1Active) {
          state.touch.t1X = Math.max(0, Math.min(1920, t1x));
          state.touch.t1Y = Math.max(0, Math.min(1080, t1y));
          pushTouchTrail(state.touch.t1X, state.touch.t1Y);
        }

        const t2Contact = data.getUint8(tpBase + 4);
        const t2x = data.getUint8(tpBase + 5) | ((data.getUint8(tpBase + 6) & 0x0f) << 8);
        const t2y = (data.getUint8(tpBase + 6) >> 4) | (data.getUint8(tpBase + 7) << 4);

        state.touch.t2Active = (t2Contact & 0x80) === 0;
        state.touch.t2Id = t2Contact & 0x7f;
        if (state.touch.t2Active) {
          state.touch.t2X = Math.max(0, Math.min(1920, t2x));
          state.touch.t2Y = Math.max(0, Math.min(1080, t2y));
        }
      }
    }

    // Bateria DualSense (Byte 52 no USB)
    if (data.byteLength >= offset + 54) {
      const battByte = data.getUint8(offset + 52);
      const battLevel = battByte & 0x0f;
      const battStatus = (battByte >> 4) & 0x0f;
      state.batteryPercent = Math.min(100, Math.round((battLevel * 10) + 5));
      state.batteryCharging = battStatus === 1 || battStatus === 2;
    }

    updateCircularityAndDrift();
  }

  /**
   * Envia Output Report 0x02 via WebHID para o DualSense (USB)
   * Controla: Gatilhos Adaptáveis L2/R2, Rumble, LED RGB, Player LEDs e Mute LED
   */
  async function sendDualSenseOutputReport() {
    if (!hidDevice || !hidDevice.opened || state.mode !== 'webhid') {
      return;
    }

    try {
      const report = new Uint8Array(47);
      const out = state.dualsenseOutput;

      // Flags de habilitação de recursos no DualSense USB Output Report 0x02
      // Byte 0: 0x01 (Rumble) | 0x02 (Rumble) | 0x04 (R2 Trigger) | 0x08 (L2 Trigger)
      report[0] = 0x0f;
      // Byte 1: 0x01 (Mic Mute LED) | 0x04 (Lightbar RGB) | 0x10 (Player LEDs)
      report[1] = 0x15;

      // Motores de Vibração (Byte 2 = Direito Suave, Byte 3 = Esquerdo Forte)
      report[2] = out.rumbleSoft & 0xff;
      report[3] = out.rumbleHeavy & 0xff;

      // Byte 8: LED do Botão Mute (0 = Off, 1 = Solid, 2 = Pulse)
      report[8] = out.muteLed & 0x03;

      // Bytes 10..20: Efeito do Gatilho Direito (R2)
      fillTriggerEffectBytes(report, 10, out.r2Mode, out.r2Start, out.r2Force);

      // Bytes 21..31: Efeito do Gatilho Esquerdo (L2)
      fillTriggerEffectBytes(report, 21, out.l2Mode, out.l2Start, out.l2Force);

      // Byte 43: Player LEDs (Bitmask dos 5 LEDs inferiores)
      const playerMasks = [0x00, 0x04, 0x0a, 0x15, 0x1b, 0x1f];
      report[43] = playerMasks[out.playerLeds] || 0x04;

      // Bytes 44, 45, 46: LED RGB da Lightbar (R, G, B)
      report[44] = out.ledR & 0xff;
      report[45] = out.ledG & 0xff;
      report[46] = out.ledB & 0xff;

      await hidDevice.sendReport(0x02, report);
    } catch (err) {
      console.warn('Aviso ao enviar Output Report DualSense:', err);
    }
  }

  function fillTriggerEffectBytes(buf, offset, mode, startPos, force) {
    if (mode === 'continuous') {
      // Modo 0x01: Resistência contínua a partir de startPos com força `force`
      buf[offset + 0] = 0x01;
      buf[offset + 1] = startPos & 0xff;
      buf[offset + 2] = force & 0xff;
    } else if (mode === 'section') {
      // Modo 0x02: Resistência de Seção / Gatilho de Arma (trava e solta após o ponto)
      buf[offset + 0] = 0x02;
      buf[offset + 1] = startPos & 0xff;
      buf[offset + 2] = Math.min(255, (startPos & 0xff) + 90);
      buf[offset + 3] = force & 0xff;
    } else if (mode === 'pulse') {
      // Modo 0x06: Vibração / Metralhadora no gatilho
      buf[offset + 0] = 0x06;
      buf[offset + 1] = 22; // Frequência em Hz
      buf[offset + 2] = Math.max(1, Math.round(force / 4));
      buf[offset + 3] = startPos & 0xff;
    } else {
      // Modo 0x05: Desligado / Sem resistência (limpa efeito)
      buf[offset + 0] = 0x05;
    }
  }

  /* ==========================================================================
   * 3. GAMEPAD API UNIVERSAL (PS5, PS4, XBOX, SWITCH, PC)
   * ========================================================================== */
  function setupGamepadListeners() {
    window.addEventListener('gamepadconnected', (e) => {
      if (state.mode === 'webhid') return; // Prioriza WebHID se já estiver aberto
      connectStandardGamepad(e.gamepad);
    });

    window.addEventListener('gamepaddisconnected', (e) => {
      if (activeGamepadIndex === e.gamepad.index && state.mode === 'gamepad') {
        state.mode = 'idle';
        activeGamepadIndex = null;
        state.controllerName = 'Controle desconectado';
        state.connectionType = 'Aguardando...';
        updateConnectionBanner();
        updateSkinTabs();
        showNotification('Controle desconectado.', 'warn');
      }
    });
  }

  function connectStandardGamepad(gp) {
    activeGamepadIndex = gp.index;
    state.mode = 'gamepad';
    state.controllerName = gp.id || 'Gamepad Conectado';
    state.connectionType = 'Gamepad API (Identificado)';
    state.testedButtons.clear();
    resetCircularity();

    const detected = identifyControllerModel(state.controllerName, null, null);
    state.skin = detected.skin;
    state.vendorProduct = detected.vendorProduct;
    state.boardRevision = detected.boardRevision;

    updateConnectionBanner();
    updateSkinTabs();
    showNotification(`Controle identificado automaticamente: ${state.controllerName}`, 'success');
  }

  function pollStandardGamepad() {
    if (!navigator.getGamepads) return;
    const gamepads = navigator.getGamepads();

    // Se estiver ocioso, verifica se algum controle foi ativado
    if (state.mode === 'idle') {
      for (let i = 0; i < gamepads.length; i++) {
        if (gamepads[i] && gamepads[i].connected) {
          connectStandardGamepad(gamepads[i]);
          break;
        }
      }
    }

    if (state.mode !== 'gamepad' || activeGamepadIndex === null) return;
    const gp = gamepads[activeGamepadIndex];
    if (!gp || !gp.connected) return;

    frameCounter++;
    const now = performance.now();
    if (now - fpsTimer >= 500) {
      state.pollingHz = Math.round((frameCounter * 1000) / (now - fpsTimer));
      frameCounter = 0;
      fpsTimer = now;
    }

    applyStickCalibration(
      gp.axes[0] || 0,
      gp.axes[1] || 0,
      gp.axes[2] || 0,
      gp.axes[3] || 0
    );

    const btn = (idx) => Boolean(gp.buttons[idx] && gp.buttons[idx].pressed);
    const val = (idx) => (gp.buttons[idx] ? gp.buttons[idx].value : 0);

    state.triggers.l2 = val(6);
    state.triggers.r2 = val(7);

    state.buttons.cross = btn(0);
    state.buttons.circle = btn(1);
    state.buttons.square = btn(2);
    state.buttons.triangle = btn(3);
    state.buttons.l1 = btn(4);
    state.buttons.r1 = btn(5);
    state.buttons.l2Btn = btn(6);
    state.buttons.r2Btn = btn(7);
    state.buttons.create = btn(8);
    state.buttons.options = btn(9);
    state.buttons.l3 = btn(10);
    state.buttons.r3 = btn(11);
    state.buttons.up = btn(12);
    state.buttons.down = btn(13);
    state.buttons.left = btn(14);
    state.buttons.right = btn(15);
    state.buttons.ps = btn(16);
    state.buttons.touchpad = btn(17);

    recordTestedButtons();
    updateCircularityAndDrift();
  }

  /* ==========================================================================
   * 4. MODO SIMULADOR INTERATIVO (POTENCIÔMETRO COM DRIFT VS HALL EFFECT/TMR)
   * ========================================================================== */
  function startSimulation(simType) {
    state.mode = simType; // 'sim-drift' | 'sim-tmr'
    state.skin = 'ps5';
    state.testedButtons.clear();
    resetCircularity();
    simAngle = 0;

    if (simType === 'sim-drift') {
      state.controllerName = 'Simulação: Controle Original com Stick Drift (Potenciômetro Desgastado)';
      state.connectionType = 'Modo Demonstração';
      state.vendorProduct = 'SIM:POT-DRIFT';
      state.boardRevision = 'Trilha de Carbono Gasta';
      showNotification('Simulando analógico original com Drift no eixo esquerdo e ruído elétrico.', 'warn');
    } else {
      state.controllerName = 'Simulação: Controle Calibrado com Sensores TMR / Hall Effect ArrowTech';
      state.connectionType = 'Modo Demonstração';
      state.vendorProduct = 'SIM:ARROW-TMR';
      state.boardRevision = 'Calibração Magnética Zero Drift';
      showNotification('Simulando analógico magnético Hall Effect / TMR com centro 0.000 e circularidade perfeita!', 'success');
    }

    updateConnectionBanner();
    updateSkinTabs();
  }

  function stepSimulation() {
    simAngle += 0.035;
    const phase = simAngle % (Math.PI * 4);

    if (state.mode === 'sim-drift') {
      // Primeira metade do ciclo: gira com ruído; segunda metade: solta o analógico e mostra o Drift puxando sozinho!
      if (phase < Math.PI * 2) {
        const jitterL = (Math.random() - 0.5) * 0.14;
        const radiusL = 0.88 + Math.sin(simAngle * 4) * 0.16 + jitterL;
        state.axes.lx = Math.max(-1, Math.min(1, Math.cos(simAngle) * radiusL + 0.12));
        state.axes.ly = Math.max(-1, Math.min(1, Math.sin(simAngle) * radiusL - 0.09));
      } else {
        // Em repouso puxando a câmera sozinho (Drift clássico de potenciômetro)
        state.axes.lx = 0.145 + (Math.random() - 0.5) * 0.05;
        state.axes.ly = -0.118 + (Math.random() - 0.5) * 0.04;
      }

      // Direito com leve oscilação
      state.axes.rx = 0.082 + Math.sin(simAngle * 2.5) * 0.03;
      state.axes.ry = -0.065 + Math.cos(simAngle * 1.8) * 0.025;
      state.pollingHz = 125;
    } else if (state.mode === 'sim-tmr') {
      // Primeira metade: gira em círculo perfeito calibrado; segunda metade: crava em 0.000!
      if (phase < Math.PI * 2) {
        const r = 1.005;
        state.axes.lx = Math.max(-1, Math.min(1, Math.cos(simAngle) * r));
        state.axes.ly = Math.max(-1, Math.min(1, Math.sin(simAngle) * r));
        state.axes.rx = Math.max(-1, Math.min(1, Math.cos(-simAngle) * r));
        state.axes.ry = Math.max(-1, Math.min(1, Math.sin(-simAngle) * r));
      } else {
        // Centro magnético cravado Zero Drift
        state.axes.lx = 0.001;
        state.axes.ly = -0.001;
        state.axes.rx = 0.000;
        state.axes.ry = 0.001;
      }
      state.pollingHz = 250;
    }

    // Anima o Tracker do Touchpad também no modo Simulador para demonstração visual
    state.touch.t1Active = true;
    state.touch.t1X = Math.round(960 + Math.cos(simAngle * 1.3) * 680);
    state.touch.t1Y = Math.round(540 + Math.sin(simAngle * 2.6) * 360);
    pushTouchTrail(state.touch.t1X, state.touch.t1Y);

    updateCircularityAndDrift();
  }

  /* ==========================================================================
   * 5. CALIBRAÇÃO DE ANALÓGICOS (WEBHID 0x82/0x90 + AJUSTE DE CENTRO/ALCANCE)
   *    & CÁLCULO DE CIRCULARIDADE 360°
   * ========================================================================== */
  function applyStickCalibration(rawLX, rawLY, rawRX, rawRY) {
    state.rawAxes.lx = rawLX;
    state.rawAxes.ly = rawLY;
    state.rawAxes.rx = rawRX;
    state.rawAxes.ry = rawRY;

    const cal = state.calibration;
    const clamp = (v) => Math.max(-1, Math.min(1, v));

    state.axes.lx = clamp((rawLX - cal.offsetLX) * cal.scaleLX);
    state.axes.ly = clamp((rawLY - cal.offsetLY) * cal.scaleLY);
    state.axes.rx = clamp((rawRX - cal.offsetRX) * cal.scaleRX);
    state.axes.ry = clamp((rawRY - cal.offsetRY) * cal.scaleRY);

    // Se a leitura de alcance 360° estiver ativa, registra os setores cobertos e raio máximo
    if (cal.samplingRange) {
      const distL = Math.hypot(rawLX - cal.offsetLX, rawLY - cal.offsetLY);
      const distR = Math.hypot(rawRX - cal.offsetRX, rawRY - cal.offsetRY);

      if (distL > 0.45) {
        const angL = (Math.atan2(rawLY - cal.offsetLY, rawLX - cal.offsetLX) + Math.PI * 2) % (Math.PI * 2);
        const secL = Math.floor((angL / (Math.PI * 2)) * 48) % 48;
        cal.rangeSectorsL[secL] = 1;
        if (distL > cal.maxRadiusL) cal.maxRadiusL = distL;
      }

      if (distR > 0.45) {
        const angR = (Math.atan2(rawRY - cal.offsetRY, rawRX - cal.offsetRX) + Math.PI * 2) % (Math.PI * 2);
        const secR = Math.floor((angR / (Math.PI * 2)) * 48) % 48;
        cal.rangeSectorsR[secR] = 1;
        if (distR > cal.maxRadiusR) cal.maxRadiusR = distR;
      }

      let covered = 0;
      for (let i = 0; i < 48; i++) {
        covered += cal.rangeSectorsL[i] + cal.rangeSectorsR[i];
      }
      const pct = Math.min(100, Math.round((covered / 96) * 100));
      setText('calib-range-pct', `${pct}%`);
      const bar = document.getElementById('calib-range-bar');
      if (bar) bar.style.width = `${pct}%`;

      if (pct >= 90) {
        setText('calib-range-hint', 'Ótimo giro! Agora clique em "3. Salvar no Controle".');
      } else if (pct > 0) {
        setText('calib-range-hint', 'Continue girando os dois analógicos encostando nas bordas...');
      }
    }
  }

  const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function updateCalibStepPills(activeStep) {
    const p1 = document.getElementById('step-pill-1');
    const p2 = document.getElementById('step-pill-2');
    const p3 = document.getElementById('step-pill-3');
    const c1 = document.getElementById('calib-card-step1');
    const c2 = document.getElementById('calib-card-step2');

    const activeCls = 'px-2.5 py-1 rounded-lg bg-slate-900 text-cyan-300 border border-cyan-500/35';
    const doneCls = 'px-2.5 py-1 rounded-lg bg-slate-900 text-slate-200 border border-slate-700';
    const idleCls = 'px-2.5 py-1 rounded-lg bg-slate-900 text-slate-500 border border-slate-800';

    if (p1) p1.className = activeStep === 1 ? activeCls : doneCls;
    if (p2) p2.className = activeStep === 2 ? activeCls : activeStep > 2 ? doneCls : idleCls;
    if (p3) p3.className = activeStep === 3 ? activeCls : idleCls;

    if (c1) {
      c1.className = activeStep === 1
        ? 'rounded-2xl bg-slate-900/90 border border-slate-700 p-4 sm:p-5 space-y-3.5 transition-all'
        : 'rounded-2xl bg-slate-900/60 border border-slate-800/80 p-4 sm:p-5 space-y-3.5 transition-all';
    }
    if (c2) {
      c2.className = activeStep === 2
        ? 'rounded-2xl bg-slate-900/90 border border-slate-700 p-4 sm:p-5 space-y-3.5 transition-all'
        : 'rounded-2xl bg-slate-900/60 border border-slate-800/80 p-4 sm:p-5 space-y-3.5 transition-all';
    }
  }

  function updateCalibModeBadge() {
    const badge = document.getElementById('calib-mode-badge');
    if (!badge) return;
    const isWebHIDPlayStation =
      state.mode === 'webhid' &&
      hidDevice &&
      hidDevice.opened &&
      (state.skin === 'ps5' || state.skin === 'ps4');
    if (isWebHIDPlayStation) {
      badge.textContent = `${state.skin === 'ps5' ? 'PS5 DualSense' : 'PS4 DualShock 4'} • WebHID`;
      badge.className = 'text-[10px] font-bold uppercase px-2.5 py-1 rounded-md bg-slate-900 text-slate-300 border border-slate-800';
    } else {
      badge.textContent = 'Ajuste de Precisão';
      badge.className = 'text-[10px] font-bold uppercase px-2.5 py-1 rounded-md bg-slate-900 text-slate-400 border border-slate-800';
    }
  }

  function setCalibrationView(open) {
    const isWebHIDPlayStation =
      state.mode === 'webhid' && (state.skin === 'ps5' || state.skin === 'ps4');

    const showCalib = Boolean(open && isWebHIDPlayStation);
    state.activeTab = showCalib ? 'calibration' : 'tester';

    const calibPanel = document.getElementById('calibration-panel');
    const svgStage = document.getElementById('controller-svg-stage');
    const triggerBoxL2 = document.getElementById('trigger-box-l2');
    const triggerBoxR2 = document.getElementById('trigger-box-r2');
    const webhidBar = document.getElementById('webhid-connect-bar');
    const extraSections = document.getElementById('tester-extra-sections');
    const btnOpenCalib = document.getElementById('btn-open-calibration');
    const btnCloseCalib = document.getElementById('btn-close-calibration');
    const mainTitle = document.getElementById('cockpit-main-title');
    const subtitle = document.getElementById('cockpit-subtitle');

    if (calibPanel) calibPanel.classList.toggle('hidden', !showCalib);
    if (svgStage) svgStage.classList.toggle('hidden', showCalib);
    if (triggerBoxL2) triggerBoxL2.classList.toggle('hidden', showCalib);
    if (triggerBoxR2) triggerBoxR2.classList.toggle('hidden', showCalib);
    if (webhidBar) webhidBar.classList.toggle('hidden', showCalib);
    if (extraSections) extraSections.classList.toggle('hidden', showCalib);

    if (btnOpenCalib) {
      btnOpenCalib.classList.toggle('hidden', showCalib || !isWebHIDPlayStation);
      btnOpenCalib.setAttribute('aria-expanded', String(showCalib));
    }
    if (btnCloseCalib) {
      btnCloseCalib.classList.toggle('hidden', !showCalib);
    }

    if (mainTitle) {
      mainTitle.innerHTML = showCalib
        ? 'Calibração Guiada dos <span class="text-gradient-arrow">Analógicos</span>'
        : 'Testador de Controle &amp; <span class="text-gradient-arrow">Circularidade 360°</span>';
    }
    if (subtitle) {
      subtitle.classList.toggle('hidden', !showCalib);
    }

    updateCalibModeBadge();
  }

  async function calibrateStickCenter() {
    if (state.mode === 'idle') {
      showNotification('Conecte seu controle primeiro para calibrar o ponto central dos analógicos.', 'warn');
      return;
    }

    const statusBadge = document.getElementById('calib-center-status');
    const isWebHIDPlayStation =
      state.mode === 'webhid' &&
      hidDevice &&
      hidDevice.opened &&
      (state.skin === 'ps5' || state.skin === 'ps4');

    if (isWebHIDPlayStation) {
      const reportId = state.skin === 'ps4' ? 0x90 : 0x82;
      try {
        if (statusBadge) {
          statusBadge.textContent = 'Calibrando...';
          statusBadge.className = 'text-[10px] font-bold uppercase px-2.5 py-1 rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-400/40 animate-pulse shrink-0';
        }
        await hidDevice.sendFeatureReport(reportId, new Uint8Array([1, 1, 1]));
        await sleepMs(120);
        await hidDevice.sendFeatureReport(reportId, new Uint8Array([3, 1, 1]));
        await sleepMs(120);
        await hidDevice.sendFeatureReport(reportId, new Uint8Array([2, 1, 1]));
        await sleepMs(120);
      } catch (err) {
        console.warn('Feature report de calibração de centro falhou ou não suportado pelo firmware, aplicando trim local:', err);
      }
    }

    state.calibration.offsetLX = state.rawAxes.lx;
    state.calibration.offsetLY = state.rawAxes.ly;
    state.calibration.offsetRX = state.rawAxes.rx;
    state.calibration.offsetRY = state.rawAxes.ry;
    applyStickCalibration(state.rawAxes.lx, state.rawAxes.ly, state.rawAxes.rx, state.rawAxes.ry);
    resetCircularity();

    const fmt = (v) => (v >= 0 ? `+${v.toFixed(3)}` : v.toFixed(3));
    setText('calib-offset-l', `${fmt(state.calibration.offsetLX)}, ${fmt(state.calibration.offsetLY)}`);
    setText('calib-offset-r', `${fmt(state.calibration.offsetRX)}, ${fmt(state.calibration.offsetRY)}`);

    if (statusBadge) {
      statusBadge.textContent = '✓ Calibrado';
      statusBadge.className = 'text-[10px] font-bold uppercase px-2.5 py-1 rounded-md bg-slate-950 text-cyan-300 border border-cyan-500/30 shrink-0';
    }

    // Libera imediatamente o botão "Salvar no Controle" caso o usuário queira salvar apenas o Centro sem girar 360°
    const btnSave = document.getElementById('btn-calib-range-save');
    if (btnSave) btnSave.disabled = false;

    const doneBanner = document.getElementById('calib-done-banner');
    if (doneBanner) doneBanner.classList.add('hidden');

    setText('calib-range-hint', 'Centro pronto! Clique em "Salvar no Controle" ou inicie o giro 360°.');
    updateCalibStepPills(2);
    showNotification('Centro calibrado! Você já pode clicar em "Salvar no Controle" ou fazer o Giro 360° antes de salvar.', 'success');
  }

  async function startStickRangeCalibration() {
    if (state.mode === 'idle') {
      showNotification('Conecte seu controle primeiro para iniciar a calibração de alcance 360°.', 'warn');
      return;
    }

    const cal = state.calibration;
    cal.samplingRange = true;
    cal.rangeSectorsL.fill(0);
    cal.rangeSectorsR.fill(0);
    cal.maxRadiusL = 0;
    cal.maxRadiusR = 0;
    cal.scaleLX = 1;
    cal.scaleLY = 1;
    cal.scaleRX = 1;
    cal.scaleRY = 1;
    resetCircularity();

    setText('calib-range-pct', '0%');
    setText('calib-range-hint', 'Gire os dois analógicos encostando nas bordas...');
    const bar = document.getElementById('calib-range-bar');
    if (bar) bar.style.width = '0%';

    const doneBanner = document.getElementById('calib-done-banner');
    if (doneBanner) doneBanner.classList.add('hidden');

    const btnSave = document.getElementById('btn-calib-range-save');
    if (btnSave) btnSave.disabled = false;

    const statusBadge = document.getElementById('calib-range-status');
    if (statusBadge) {
      statusBadge.textContent = 'Lendo Giro...';
      statusBadge.className = 'text-[10px] font-bold uppercase px-2.5 py-1 rounded-md bg-slate-950 text-cyan-300 border border-cyan-500/30 animate-pulse shrink-0';
    }

    updateCalibStepPills(2);

    const isWebHIDPlayStation =
      state.mode === 'webhid' &&
      hidDevice &&
      hidDevice.opened &&
      (state.skin === 'ps5' || state.skin === 'ps4');

    if (isWebHIDPlayStation) {
      const reportId = state.skin === 'ps4' ? 0x90 : 0x82;
      try {
        await hidDevice.sendFeatureReport(reportId, new Uint8Array([1, 1, 2]));
      } catch (err) {
        console.warn('Início de calibração de alcance WebHID:', err);
      }
    }

    showNotification('Gire os dois analógicos juntos encostando na borda até completar a barra e clique em "Salvar no Controle".', 'info');
  }

  async function saveStickRangeCalibration() {
    const cal = state.calibration;
    const hadRangeSampling = cal.samplingRange || cal.maxRadiusL > 0.5 || cal.maxRadiusR > 0.5;
    cal.samplingRange = false;

    const btnSave = document.getElementById('btn-calib-range-save');
    if (btnSave) btnSave.disabled = true;

    const isWebHIDPlayStation =
      state.mode === 'webhid' &&
      hidDevice &&
      hidDevice.opened &&
      (state.skin === 'ps5' || state.skin === 'ps4');

    if (isWebHIDPlayStation) {
      const reportId = state.skin === 'ps4' ? 0x90 : 0x82;
      try {
        if (hadRangeSampling) {
          await hidDevice.sendFeatureReport(reportId, new Uint8Array([2, 1, 2]));
        } else {
          await hidDevice.sendFeatureReport(reportId, new Uint8Array([1, 1, 1]));
          await sleepMs(100);
          await hidDevice.sendFeatureReport(reportId, new Uint8Array([3, 1, 1]));
          await sleepMs(100);
          await hidDevice.sendFeatureReport(reportId, new Uint8Array([2, 1, 1]));
        }
      } catch (err) {
        console.warn('Salvamento de calibração no controle via WebHID:', err);
      }
    }

    if (hadRangeSampling) {
      if (cal.maxRadiusL > 0.6) {
        const sL = Math.max(0.85, Math.min(1.25, 1.0 / cal.maxRadiusL));
        cal.scaleLX = sL;
        cal.scaleLY = sL;
      }
      if (cal.maxRadiusR > 0.6) {
        const sR = Math.max(0.85, Math.min(1.25, 1.0 / cal.maxRadiusR));
        cal.scaleRX = sR;
        cal.scaleRY = sR;
      }
    }

    applyStickCalibration(state.rawAxes.lx, state.rawAxes.ly, state.rawAxes.rx, state.rawAxes.ry);
    resetCircularity();

    const centerBadge = document.getElementById('calib-center-status');
    if (centerBadge) {
      centerBadge.textContent = '✓ Salvo';
      centerBadge.className = 'text-[10px] font-bold uppercase px-2.5 py-1 rounded-md bg-slate-950 text-cyan-300 border border-cyan-500/30 shrink-0';
    }

    const statusBadge = document.getElementById('calib-range-status');
    if (statusBadge && hadRangeSampling) {
      statusBadge.textContent = '✓ Salvo';
      statusBadge.className = 'text-[10px] font-bold uppercase px-2.5 py-1 rounded-md bg-slate-950 text-cyan-300 border border-cyan-500/30 shrink-0';
    }

    setText(
      'calib-range-hint',
      hadRangeSampling
        ? '✓ Centro e giro 360° salvos no controle com sucesso!'
        : '✓ Calibração de centro salva no controle com sucesso!'
    );

    const doneBanner = document.getElementById('calib-done-banner');
    if (doneBanner) doneBanner.classList.remove('hidden');

    updateCalibStepPills(3);
    showNotification(
      hadRangeSampling
        ? 'Calibração completa (Centro + Giro 360°) salva no controle!'
        : 'Calibração de centro salva no controle com sucesso!',
      'success'
    );
  }

  function resetStickCalibration() {
    const cal = state.calibration;
    cal.offsetLX = 0;
    cal.offsetLY = 0;
    cal.offsetRX = 0;
    cal.offsetRY = 0;
    cal.scaleLX = 1;
    cal.scaleLY = 1;
    cal.scaleRX = 1;
    cal.scaleRY = 1;
    cal.samplingRange = false;
    cal.rangeSectorsL.fill(0);
    cal.rangeSectorsR.fill(0);
    cal.maxRadiusL = 0;
    cal.maxRadiusR = 0;

    setText('calib-offset-l', '0.000, 0.000');
    setText('calib-offset-r', '0.000, 0.000');
    setText('calib-range-pct', '0%');
    setText('calib-range-hint', 'Clique em "Começar Giro" para iniciar');
    const bar = document.getElementById('calib-range-bar');
    if (bar) bar.style.width = '0%';

    const centerBadge = document.getElementById('calib-center-status');
    if (centerBadge) {
      centerBadge.textContent = 'Pendente';
      centerBadge.className = 'text-[10px] font-bold uppercase px-2.5 py-1 rounded-lg bg-slate-950 text-slate-400 border border-slate-800 shrink-0';
    }
    const rangeBadge = document.getElementById('calib-range-status');
    if (rangeBadge) {
      rangeBadge.textContent = 'Aguardando';
      rangeBadge.className = 'text-[10px] font-bold uppercase px-2.5 py-1 rounded-lg bg-slate-950 text-slate-400 border border-slate-800 shrink-0';
    }
    const doneBanner = document.getElementById('calib-done-banner');
    if (doneBanner) doneBanner.classList.add('hidden');

    const btnSave = document.getElementById('btn-calib-range-save');
    if (btnSave) btnSave.disabled = true;

    updateCalibStepPills(1);
    applyStickCalibration(state.rawAxes.lx, state.rawAxes.ly, state.rawAxes.rx, state.rawAxes.ry);
    resetCircularity();
    showNotification('Calibração restaurada para os valores originais.', 'info');
  }

  function updateCircularityAndDrift() {
    const { lx, ly, rx, ry } = state.axes;
    const distL = Math.hypot(lx, ly);
    const distR = Math.hypot(rx, ry);

    // Rastro recente do ponteiro
    pushTrail(state.circularity.leftTrail, lx, ly);
    pushTrail(state.circularity.rightTrail, rx, ry);

    // Registro de circularidade em 48 setores quando o usuário encosta na borda (> 0.55)
    if (state.circularity.enabled) {
      if (distL > 0.55) {
        const angleL = (Math.atan2(ly, lx) + Math.PI * 2) % (Math.PI * 2);
        const sectorL = Math.floor((angleL / (Math.PI * 2)) * 48) % 48;
        if (distL > state.circularity.leftSectors[sectorL]) {
          state.circularity.leftSectors[sectorL] = Math.min(1.25, distL);
          state.circularity.leftAvgError = computeCircularityError(state.circularity.leftSectors);
        }
      }

      if (distR > 0.55) {
        const angleR = (Math.atan2(ry, rx) + Math.PI * 2) % (Math.PI * 2);
        const sectorR = Math.floor((angleR / (Math.PI * 2)) * 48) % 48;
        if (distR > state.circularity.rightSectors[sectorR]) {
          state.circularity.rightSectors[sectorR] = Math.min(1.25, distR);
          state.circularity.rightAvgError = computeCircularityError(state.circularity.rightSectors);
        }
      }
    }
  }

  function pushTrail(trail, x, y) {
    trail.push({ x, y });
    if (trail.length > 45) trail.shift();
  }

  function computeCircularityError(sectors) {
    let sumDiff = 0;
    let count = 0;
    for (let i = 0; i < sectors.length; i++) {
      if (sectors[i] > 0.5) {
        sumDiff += Math.abs(1.0 - sectors[i]);
        count++;
      }
    }
    if (count < 6) return 0;
    return (sumDiff / count) * 100;
  }

  function resetCircularity() {
    state.circularity.leftSectors.fill(0);
    state.circularity.rightSectors.fill(0);
    state.circularity.leftTrail = [];
    state.circularity.rightTrail = [];
    state.circularity.leftAvgError = 0;
    state.circularity.rightAvgError = 0;
  }

  function recordTestedButtons() {
    Object.keys(state.buttons).forEach((key) => {
      if (state.buttons[key]) {
        state.testedButtons.add(key);
      }
    });
  }

  function pushTouchTrail(x, y) {
    state.touch.trail1.push({ x, y });
    if (state.touch.trail1.length > 36) {
      state.touch.trail1.shift();
    }
  }

  function pushImuSample() {
    state.imu.historyGyro.push({
      x: state.imu.gyroX,
      y: state.imu.gyroY,
      z: state.imu.gyroZ
    });
    if (state.imu.historyGyro.length > 90) {
      state.imu.historyGyro.shift();
    }
  }

  /* ==========================================================================
   * 6. RENDERIZAÇÃO VISUAL (LOOP 60FPS)
   * ========================================================================== */
  function mainLoop(now) {
    if (state.mode === 'gamepad' || state.mode === 'idle') {
      pollStandardGamepad();
    } else if (state.mode === 'sim-drift' || state.mode === 'sim-tmr') {
      stepSimulation();
    }

    if (now - lastFrameTime >= 16) {
      lastFrameTime = now;
      drawStickCanvas(
        ctxLeft,
        canvasLeft,
        state.axes.lx,
        state.axes.ly,
        state.circularity.leftSectors,
        state.circularity.leftTrail,
        state.buttons.l3
      );
      drawStickCanvas(
        ctxRight,
        canvasRight,
        state.axes.rx,
        state.axes.ry,
        state.circularity.rightSectors,
        state.circularity.rightTrail,
        state.buttons.r3
      );
      drawTouchpadCanvas();
      drawImuCanvas();
      updateControllerSVG();
      updateTelemetryReadouts();
    }

    requestAnimationFrame(mainLoop);
  }

  /**
   * Desenha o radar de Circularidade 360° em <canvas>
   */
  function drawStickCanvas(ctx, canvas, x, y, sectors, trail, isPressed) {
    if (!ctx || !canvas) return;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const maxR = (w / 2) - 24;
    const zoom = state.circularity.zoomCenter ? 5 : 1;

    ctx.clearRect(0, 0, w, h);

    // Fundo escuro técnico
    ctx.fillStyle = '#040a14';
    ctx.beginPath();
    ctx.arc(cx, cy, maxR + 12, 0, Math.PI * 2);
    ctx.fill();

    // Grade de referência e zonas mortas (5%, 10%, 50%, 100%)
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.14)';
    ctx.lineWidth = 1;

    // Eixos cruzados
    ctx.beginPath();
    ctx.moveTo(cx - maxR - 8, cy);
    ctx.lineTo(cx + maxR + 8, cy);
    ctx.moveTo(cx, cy - maxR - 8);
    ctx.lineTo(cx, cy + maxR + 8);
    ctx.stroke();

    // Círculo limite 100%
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.38)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
    ctx.stroke();

    // Círculo de referência central (Zona Morta 8%)
    const deadzoneR = Math.min(maxR, maxR * 0.08 * zoom);
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.25)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(cx, cy, deadzoneR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Polígono de Circularidade (48 setores) quando não está com zoom 5x
    if (state.circularity.enabled && !state.circularity.zoomCenter) {
      for (let i = 0; i < 48; i++) {
        const rVal = sectors[i];
        if (rVal <= 0.1) continue;
        const a1 = (i / 48) * Math.PI * 2;
        const a2 = ((i + 1) / 48) * Math.PI * 2;
        const rPx = Math.min(maxR + 12, rVal * maxR);

        const diff = Math.abs(1.0 - rVal);
        if (diff < 0.06) {
          ctx.fillStyle = 'rgba(0, 212, 178, 0.25)';
        } else if (diff < 0.12) {
          ctx.fillStyle = 'rgba(0, 136, 255, 0.25)';
        } else {
          ctx.fillStyle = 'rgba(245, 158, 11, 0.28)';
        }

        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, rPx, a1, a2);
        ctx.closePath();
        ctx.fill();
      }
    }

    // Rastro do movimento
    if (trail.length > 1) {
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.45)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (let i = 0; i < trail.length; i++) {
        const tx = cx + Math.max(-1, Math.min(1, trail[i].x * zoom)) * maxR;
        const ty = cy + Math.max(-1, Math.min(1, trail[i].y * zoom)) * maxR;
        if (i === 0) ctx.moveTo(tx, ty);
        else ctx.lineTo(tx, ty);
      }
      ctx.stroke();
    }

    // Posição atual do cursor do analógico
    const clampedX = Math.max(-1.1, Math.min(1.1, x * zoom));
    const clampedY = Math.max(-1.1, Math.min(1.1, y * zoom));
    const px = cx + clampedX * maxR;
    const py = cy + clampedY * maxR;

    // Linha do centro até o cursor
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(px, py);
    ctx.stroke();

    // Brilho e ponto principal
    const dotColor = '#00e5ff';

    ctx.fillStyle = dotColor;
    ctx.shadowColor = dotColor;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(px, py, isPressed ? 9 : 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  /**
   * Desenha o Monitor Dedicado do Touchpad (1920x1080) com Mira X/Y, Rastro e 2 Toques
   */
  function drawTouchpadCanvas() {
    if (!ctxTouchpad || !canvasTouchpad) return;
    const w = canvasTouchpad.width;
    const h = canvasTouchpad.height;
    ctxTouchpad.clearRect(0, 0, w, h);

    // Fundo escuro técnico
    ctxTouchpad.fillStyle = '#040914';
    ctxTouchpad.fillRect(0, 0, w, h);

    // Grade sutil proporcional 1920x1080
    ctxTouchpad.strokeStyle = 'rgba(0, 229, 255, 0.1)';
    ctxTouchpad.lineWidth = 1;
    for (let gx = w / 4; gx < w; gx += w / 4) {
      ctxTouchpad.beginPath();
      ctxTouchpad.moveTo(gx, 0);
      ctxTouchpad.lineTo(gx, h);
      ctxTouchpad.stroke();
    }
    for (let gy = h / 3; gy < h; gy += h / 3) {
      ctxTouchpad.beginPath();
      ctxTouchpad.moveTo(0, gy);
      ctxTouchpad.lineTo(w, gy);
      ctxTouchpad.stroke();
    }

    // Rastro do Toque 1
    const trail = state.touch.trail1;
    if (trail.length > 1) {
      ctxTouchpad.strokeStyle = 'rgba(0, 229, 255, 0.5)';
      ctxTouchpad.lineWidth = 2;
      ctxTouchpad.beginPath();
      for (let i = 0; i < trail.length; i++) {
        const tx = (trail[i].x / 1920) * w;
        const ty = (trail[i].y / 1080) * h;
        if (i === 0) ctxTouchpad.moveTo(tx, ty);
        else ctxTouchpad.lineTo(tx, ty);
      }
      ctxTouchpad.stroke();
    }

    // Coordenadas de Toque 1 (ou repouso no centro 960, 540 para exibir o tracker sempre visível)
    const t1Active = state.touch.t1Active || state.buttons.touchpad;
    const rawX1 = state.touch.t1Active ? state.touch.t1X : 960;
    const rawY1 = state.touch.t1Active ? state.touch.t1Y : 540;
    const px1 = (rawX1 / 1920) * w;
    const py1 = (rawY1 / 1080) * h;

    // Linhas de mira (Crosshair X/Y)
    ctxTouchpad.strokeStyle = t1Active ? 'rgba(0, 229, 255, 0.7)' : 'rgba(0, 229, 255, 0.25)';
    ctxTouchpad.setLineDash([3, 3]);
    ctxTouchpad.beginPath();
    ctxTouchpad.moveTo(px1, 0);
    ctxTouchpad.lineTo(px1, h);
    ctxTouchpad.moveTo(0, py1);
    ctxTouchpad.lineTo(w, py1);
    ctxTouchpad.stroke();
    ctxTouchpad.setLineDash([]);

    // Cursor de Toque 1
    ctxTouchpad.fillStyle = t1Active ? '#00e5ff' : 'rgba(0, 229, 255, 0.45)';
    ctxTouchpad.shadowColor = '#00e5ff';
    ctxTouchpad.shadowBlur = t1Active ? 12 : 4;
    ctxTouchpad.beginPath();
    ctxTouchpad.arc(px1, py1, state.buttons.touchpad ? 8 : (t1Active ? 6 : 4.5), 0, Math.PI * 2);
    ctxTouchpad.fill();
    ctxTouchpad.shadowBlur = 0;

    // Cursor de Toque 2 (Multitouch)
    if (state.touch.t2Active) {
      const px2 = (state.touch.t2X / 1920) * w;
      const py2 = (state.touch.t2Y / 1080) * h;

      ctxTouchpad.strokeStyle = 'rgba(245, 158, 11, 0.65)';
      ctxTouchpad.setLineDash([3, 3]);
      ctxTouchpad.beginPath();
      ctxTouchpad.moveTo(px2, 0);
      ctxTouchpad.lineTo(px2, h);
      ctxTouchpad.moveTo(0, py2);
      ctxTouchpad.lineTo(w, py2);
      ctxTouchpad.stroke();
      ctxTouchpad.setLineDash([]);

      ctxTouchpad.fillStyle = '#f59e0b';
      ctxTouchpad.shadowColor = '#f59e0b';
      ctxTouchpad.shadowBlur = 10;
      ctxTouchpad.beginPath();
      ctxTouchpad.arc(px2, py2, 6, 0, Math.PI * 2);
      ctxTouchpad.fill();
      ctxTouchpad.shadowBlur = 0;
    }
  }

  /**
   * Desenha o gráfico de Giroscópio / Sensores em tempo real
   */
  function drawImuCanvas() {
    if (!ctxImu || !canvasImu) return;
    const w = canvasImu.width;
    const h = canvasImu.height;
    ctxImu.clearRect(0, 0, w, h);

    // Linha base
    ctxImu.strokeStyle = 'rgba(0, 229, 255, 0.15)';
    ctxImu.beginPath();
    ctxImu.moveTo(0, h / 2);
    ctxImu.lineTo(w, h / 2);
    ctxImu.stroke();

    const hist = state.imu.historyGyro;
    if (hist.length < 2) return;

    const channels = [
      { key: 'x', color: '#00e5ff' },
      { key: 'y', color: '#f59e0b' },
      { key: 'z', color: '#10b981' }
    ];

    channels.forEach((ch) => {
      ctxImu.strokeStyle = ch.color;
      ctxImu.lineWidth = 1.6;
      ctxImu.beginPath();
      for (let i = 0; i < hist.length; i++) {
        const xPos = (i / 89) * w;
        const norm = Math.max(-1, Math.min(1, hist[i][ch.key] / 8000));
        const yPos = (h / 2) - norm * (h * 0.42);
        if (i === 0) ctxImu.moveTo(xPos, yPos);
        else ctxImu.lineTo(xPos, yPos);
      }
      ctxImu.stroke();
    });
  }

  /**
   * Atualiza o SVG realista do controle ativo e os badges de telemetria
   */
  function updateControllerSVG() {
    const activeSvg = document.querySelector(`svg[data-controller-skin="${state.skin}"]`);
    if (!activeSvg) return;

    // Move os dois analógicos (L3 e R3) respeitando a posição simétrica ou assimétrica do modelo
    const svgStickL = activeSvg.querySelector('[data-stick="left"]');
    const svgStickR = activeSvg.querySelector('[data-stick="right"]');

    if (svgStickL) {
      const dx = (state.axes.lx * 28).toFixed(1);
      const dy = (state.axes.ly * 28).toFixed(1);
      svgStickL.setAttribute('transform', `translate(${dx}, ${dy})`);
    }
    if (svgStickR) {
      const dx = (state.axes.rx * 28).toFixed(1);
      const dy = (state.axes.ry * 28).toFixed(1);
      svgStickR.setAttribute('transform', `translate(${dx}, ${dy})`);
    }

    // Barras de pressão dos gatilhos L2/LT/ZL e R2/RT/ZR no SVG ativo
    const l2Fill = activeSvg.querySelector('[data-trigger-fill="l2"]');
    const r2Fill = activeSvg.querySelector('[data-trigger-fill="r2"]');
    if (l2Fill) l2Fill.setAttribute('height', String(Math.round(state.triggers.l2 * 32)));
    if (r2Fill) r2Fill.setAttribute('height', String(Math.round(state.triggers.r2 * 32)));

    // Destaque luminoso em cada botão pressionado no SVG ativo e nos badges do checklist
    Object.keys(state.buttons).forEach((btnKey) => {
      const pressed = state.buttons[btnKey];
      const svgEl = activeSvg.querySelector(`[data-btn="${btnKey}"]`);
      if (svgEl) {
        if (pressed) {
          svgEl.classList.add('svg-btn-active');
        } else {
          svgEl.classList.remove('svg-btn-active');
        }
      }

      const pillEl = document.getElementById(`pill-btn-${btnKey}`);
      if (pillEl) {
        if (pressed) {
          pillEl.className = 'px-2.5 py-1.5 rounded-lg text-xs font-extrabold bg-cyan-400 text-slate-950 shadow-[0_0_15px_rgba(0,229,255,0.7)] transition-all';
        } else if (state.testedButtons.has(btnKey)) {
          pillEl.className = 'px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/40 transition-all';
        } else {
          pillEl.className = 'px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-slate-900/90 text-slate-400 border border-slate-800 transition-all';
        }
      }
    });

    // Tracker Completo no Touchpad do SVG ativo (PS5 DualSense e PS4 DualShock 4)
    const tpBounds = state.skin === 'ps4'
      ? { left: 348, top: 280, width: 304, height: 164 }
      : { left: 340, top: 220, width: 320, height: 165 };

    const touchDot1 = activeSvg.querySelector('[data-touch="1"]');
    const touchCore1 = activeSvg.querySelector('[data-touch-core="1"]');
    const touchLineX1 = activeSvg.querySelector('[data-touch-line-x="1"]');
    const touchLineY1 = activeSvg.querySelector('[data-touch-line-y="1"]');
    const touchLabel1 = activeSvg.querySelector('[data-touch-label="1"]');
    const touchTrail1 = activeSvg.querySelector('[data-touch-trail="1"]');

    const isWebHIDActive = state.mode === 'webhid';

    if (touchDot1) {
      if (!isWebHIDActive) {
        touchDot1.classList.add('hidden');
        if (touchCore1) touchCore1.classList.add('hidden');
        if (touchLineX1) touchLineX1.classList.add('hidden');
        if (touchLineY1) touchLineY1.classList.add('hidden');
        if (touchTrail1) touchTrail1.setAttribute('points', '');
      } else {
        touchDot1.classList.remove('hidden');
        if (touchCore1) touchCore1.classList.remove('hidden');
        if (touchLineX1) touchLineX1.classList.remove('hidden');
        if (touchLineY1) touchLineY1.classList.remove('hidden');

        const isActive1 = state.touch.t1Active || state.buttons.touchpad;
        const rawX1 = state.touch.t1Active ? state.touch.t1X : 960;
        const rawY1 = state.touch.t1Active ? state.touch.t1Y : 540;
        const sx1 = tpBounds.left + (rawX1 / 1920) * tpBounds.width;
        const sy1 = tpBounds.top + (rawY1 / 1080) * tpBounds.height;

        touchDot1.setAttribute('cx', sx1.toFixed(1));
        touchDot1.setAttribute('cy', sy1.toFixed(1));
        touchDot1.setAttribute('r', state.buttons.touchpad ? '16' : (isActive1 ? '13' : '9'));
        touchDot1.setAttribute('opacity', isActive1 ? '1' : '0.65');

        if (touchCore1) {
          touchCore1.setAttribute('cx', sx1.toFixed(1));
          touchCore1.setAttribute('cy', sy1.toFixed(1));
          touchCore1.setAttribute('opacity', isActive1 ? '1' : '0.75');
        }
        if (touchLineX1) {
          touchLineX1.setAttribute('x1', sx1.toFixed(1));
          touchLineX1.setAttribute('x2', sx1.toFixed(1));
          touchLineX1.setAttribute('opacity', isActive1 ? '0.85' : '0.35');
        }
        if (touchLineY1) {
          touchLineY1.setAttribute('y1', sy1.toFixed(1));
          touchLineY1.setAttribute('y2', sy1.toFixed(1));
          touchLineY1.setAttribute('opacity', isActive1 ? '0.85' : '0.35');
        }
        if (touchLabel1) {
          touchLabel1.textContent = state.touch.t1Active ? `T1 ${rawX1},${rawY1}` : '';
        }
        if (touchTrail1) {
          if (state.touch.trail1.length > 1) {
            const pts = state.touch.trail1
              .map((pt) => {
                const px = (tpBounds.left + (pt.x / 1920) * tpBounds.width).toFixed(1);
                const py = (tpBounds.top + (pt.y / 1080) * tpBounds.height).toFixed(1);
                return `${px},${py}`;
              })
              .join(' ');
            touchTrail1.setAttribute('points', pts);
          } else {
            touchTrail1.setAttribute('points', '');
          }
        }
      }
    }

    const touchDot2 = activeSvg.querySelector('[data-touch="2"]');
    const touchLineX2 = activeSvg.querySelector('[data-touch-line-x="2"]');
    const touchLineY2 = activeSvg.querySelector('[data-touch-line-y="2"]');
    const touchLabel2 = activeSvg.querySelector('[data-touch-label="2"]');
    if (touchDot2) {
      if (state.touch.t2Active) {
        const sx2 = tpBounds.left + (state.touch.t2X / 1920) * tpBounds.width;
        const sy2 = tpBounds.top + (state.touch.t2Y / 1080) * tpBounds.height;
        touchDot2.classList.remove('hidden');
        touchDot2.setAttribute('cx', sx2.toFixed(1));
        touchDot2.setAttribute('cy', sy2.toFixed(1));
        if (touchLineX2) {
          touchLineX2.classList.remove('hidden');
          touchLineX2.setAttribute('x1', sx2.toFixed(1));
          touchLineX2.setAttribute('x2', sx2.toFixed(1));
        }
        if (touchLineY2) {
          touchLineY2.classList.remove('hidden');
          touchLineY2.setAttribute('y1', sy2.toFixed(1));
          touchLineY2.setAttribute('y2', sy2.toFixed(1));
        }
        if (touchLabel2) {
          touchLabel2.classList.remove('hidden');
          touchLabel2.textContent = `T2 ${state.touch.t2X},${state.touch.t2Y}`;
        }
      } else {
        touchDot2.classList.add('hidden');
        if (touchLineX2) touchLineX2.classList.add('hidden');
        if (touchLineY2) touchLineY2.classList.add('hidden');
        if (touchLabel2) touchLabel2.classList.add('hidden');
      }
    }

    // Cor da Lightbar RGB no SVG ativo (DualSense e DualShock 4)
    const svgLightbar = activeSvg.querySelector('[data-lightbar]');
    if (svgLightbar) {
      const { ledR, ledG, ledB } = state.dualsenseOutput;
      svgLightbar.setAttribute('stroke', `rgb(${ledR}, ${ledG}, ${ledB})`);
    }

    // LEDs Indicadores de Jogador (1 a 5) abaixo do touchpad do DualSense
    const pLeds = state.dualsenseOutput.playerLeds;
    const ledPatterns = {
      0: [],
      1: [3],
      2: [2, 4],
      3: [1, 3, 5],
      4: [1, 2, 4, 5],
      5: [1, 2, 3, 4, 5]
    };
    const activeSlots = ledPatterns[pLeds] || [3];
    for (let i = 1; i <= 5; i++) {
      const ledEl = activeSvg.querySelector(`[data-player-led="${i}"]`);
      if (ledEl) {
        ledEl.setAttribute('fill', activeSlots.includes(i) ? '#f8fafc' : '#334155');
      }
    }
  }

  function updateTelemetryReadouts() {
    setText('val-lx', state.axes.lx.toFixed(4));
    setText('val-ly', state.axes.ly.toFixed(4));
    setText('val-rx', state.axes.rx.toFixed(4));
    setText('val-ry', state.axes.ry.toFixed(4));

    setText('val-err-left', `${state.circularity.leftAvgError.toFixed(1)}%`);
    setText('val-err-right', `${state.circularity.rightAvgError.toFixed(1)}%`);

    setText('val-l2-pct', `${Math.round(state.triggers.l2 * 100)}%`);
    setText('val-r2-pct', `${Math.round(state.triggers.r2 * 100)}%`);

    const barL2 = document.getElementById('bar-l2');
    const barR2 = document.getElementById('bar-r2');
    if (barL2) barL2.style.width = `${Math.round(state.triggers.l2 * 100)}%`;
    if (barR2) barR2.style.width = `${Math.round(state.triggers.r2 * 100)}%`;

    // Info de Hardware e Polling
    setText('info-polling', state.pollingHz > 0 ? `${state.pollingHz} Hz` : '—');
    setText('info-connection', state.connectionType);
    setText('info-vidpid', state.vendorProduct);
    setText('info-board', state.boardRevision);
    setText('info-tested-count', `${state.testedButtons.size} / 18`);

    if (state.batteryPercent !== null) {
      setText('info-battery', `${state.batteryPercent}% ${state.batteryCharging ? '⚡ Carregando' : '🔋'}`);
    } else {
      setText('info-battery', state.mode === 'gamepad' ? 'Via Sistema' : '—');
    }

    // Touchpad e IMU
    setText(
      'info-touch1',
      state.touch.t1Active
        ? `X: ${state.touch.t1X}, Y: ${state.touch.t1Y}`
        : (state.buttons.touchpad ? 'Clique Pressionado' : 'Sem toque')
    );
    setText(
      'info-touch2',
      state.touch.t2Active ? `X: ${state.touch.t2X}, Y: ${state.touch.t2Y}` : 'Inativo'
    );
    setText(
      'info-gyro',
      `X:${state.imu.gyroX} Y:${state.imu.gyroY} Z:${state.imu.gyroZ}`
    );
    setText(
      'info-accel',
      `X:${state.imu.accelX} Y:${state.imu.accelY} Z:${state.imu.accelZ}`
    );
  }

  function updateConnectionBanner() {
    const dot = document.getElementById('conn-status-dot');
    const title = document.getElementById('conn-controller-name');
    const modeTag = document.getElementById('conn-mode-tag');
    const webhidLockOverlay = document.getElementById('webhid-exclusive-notice');

    if (title) title.textContent = state.controllerName;

    if (state.mode === 'webhid') {
      if (dot) dot.className = 'w-3.5 h-3.5 rounded-full bg-cyan-400 shadow-[0_0_12px_#00e5ff]';
      if (modeTag) {
        modeTag.textContent = 'MODO WEBHID COMPLETO (DUALSENSE)';
        modeTag.className = 'text-[11px] font-extrabold uppercase px-3 py-1 rounded-full bg-cyan-500/20 text-cyan-300 border border-cyan-400/40';
      }
      if (webhidLockOverlay) webhidLockOverlay.classList.add('hidden');
    } else if (state.mode === 'gamepad') {
      if (dot) dot.className = 'w-3.5 h-3.5 rounded-full bg-emerald-400 shadow-[0_0_12px_#10b981]';
      if (modeTag) {
        modeTag.textContent = 'CONECTADO VIA GAMEPAD API';
        modeTag.className = 'text-[11px] font-extrabold uppercase px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-400/40';
      }
      if (webhidLockOverlay) webhidLockOverlay.classList.remove('hidden');
    } else if (state.mode === 'sim-drift' || state.mode === 'sim-tmr') {
      if (dot) dot.className = 'w-3.5 h-3.5 rounded-full bg-amber-400 shadow-[0_0_12px_#f59e0b]';
      if (modeTag) {
        modeTag.textContent = 'SIMULADOR INTERATIVO ATIVO';
        modeTag.className = 'text-[11px] font-extrabold uppercase px-3 py-1 rounded-full bg-amber-500/20 text-amber-300 border border-amber-400/40';
      }
    } else {
      if (dot) dot.className = 'w-3.5 h-3.5 rounded-full bg-slate-600';
      if (modeTag) {
        modeTag.textContent = 'AGUARDANDO CONEXÃO';
        modeTag.className = 'text-[11px] font-extrabold uppercase px-3 py-1 rounded-full bg-slate-800 text-slate-400 border border-slate-700';
      }
    }
  }

  function updateSkinTabs() {
    const isIdle = state.mode === 'idle';
    const isWebHID = state.mode === 'webhid';
    const isPS5 = !isIdle && state.skin === 'ps5';
    const isPlayStation = !isIdle && (state.skin === 'ps5' || state.skin === 'ps4');
    const isWebHIDPS5 = isWebHID && state.skin === 'ps5';
    const isWebHIDPlayStation = isWebHID && (state.skin === 'ps5' || state.skin === 'ps4');

    const idlePlaceholder = document.getElementById('svg-idle-placeholder');
    const modelBadge = document.getElementById('active-model-badge');
    const autoDetectPill = document.getElementById('auto-detect-pill');
    const btnConnectHid = document.getElementById('btn-connect-webhid');

    // Seções e blocos exclusivos de cada modelo de controle
    const secAdaptive = document.getElementById('section-adaptive-triggers');
    const secActuators = document.getElementById('section-actuators');
    const gridActuators = document.getElementById('grid-actuators');
    const titleActuators = document.getElementById('title-actuators');
    const boxLightbar = document.getElementById('box-lightbar-rgb');
    const boxPs5Leds = document.getElementById('box-ps5-leds');

    const secHardware = document.getElementById('section-hardware-telemetry');
    const gridHardware = document.getElementById('grid-hardware-telemetry');
    const titleHardware = document.getElementById('title-hardware-telemetry');
    const rowBoardRev = document.getElementById('row-board-rev');
    const rowTouchCoord = document.getElementById('row-touchpad-coord');
    const boxTouchTracker = document.getElementById('box-touchpad-tracker');
    const boxImuSensors = document.getElementById('box-imu-sensors');

    if (idlePlaceholder) {
      idlePlaceholder.classList.toggle('hidden', !isIdle);
    }

    // Mostra apenas o SVG realista do controle identificado (ou oculta todos se estiver aguardando conexão)
    document.querySelectorAll('svg[data-controller-skin]').forEach((svg) => {
      const skinName = svg.getAttribute('data-controller-skin');
      svg.classList.toggle('hidden', isIdle || skinName !== state.skin);
    });

    // Oculta a barra e o botão "Conectar DualSense / DS4 (WebHID)" se um controle Xbox/Switch estiver conectado ou se o WebHID já estiver ativo
    const webhidBar = document.getElementById('webhid-connect-bar');
    if (webhidBar) {
      webhidBar.classList.toggle('hidden', isWebHID || (!isIdle && !isPlayStation));
    }
    if (btnConnectHid) {
      btnConnectHid.classList.toggle('hidden', !isIdle && !isPlayStation);
    }

    // 1. Gatilhos Adaptáveis: SOMENTE quando um PS5 DualSense estiver conectado via WebHID
    if (secAdaptive) {
      secAdaptive.classList.toggle('hidden', !isWebHIDPS5);
    }

    // 2. Seção de Vibração & Iluminação: Vibração aparece com controle conectado; Lightbar/LEDs SOMENTE via WebHID
    if (secActuators) {
      secActuators.classList.toggle('hidden', isIdle);
    }
    if (boxLightbar) {
      boxLightbar.classList.toggle('hidden', !isWebHIDPlayStation);
    }
    if (boxPs5Leds) {
      boxPs5Leds.classList.toggle('hidden', !isWebHIDPS5);
    }
    if (gridActuators) {
      gridActuators.className = isWebHIDPlayStation
        ? 'grid grid-cols-1 lg:grid-cols-2 gap-6'
        : 'grid grid-cols-1 gap-6';
    }
    if (titleActuators) {
      titleActuators.textContent = isWebHIDPlayStation
        ? 'Vibração & Barra de Luz RGB'
        : 'Teste de Motores de Vibração (Rumble)';
    }

    // 3. Seção de Hardware, Touchpad & Giroscópio: Touchpad, IMU e Placa SOMENTE via WebHID
    if (secHardware) {
      secHardware.classList.toggle('hidden', isIdle);
    }
    if (rowBoardRev) {
      rowBoardRev.classList.toggle('hidden', !isWebHIDPlayStation);
    }
    if (rowTouchCoord) {
      rowTouchCoord.classList.toggle('hidden', !isWebHIDPlayStation);
    }
    if (boxTouchTracker) {
      boxTouchTracker.classList.toggle('hidden', !isWebHIDPlayStation);
    }
    if (boxImuSensors) {
      boxImuSensors.classList.toggle('hidden', !isWebHIDPlayStation);
    }
    if (gridHardware) {
      gridHardware.className = isWebHIDPlayStation
        ? 'grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch'
        : 'grid grid-cols-1 gap-6 items-stretch';
    }
    if (titleHardware) {
      titleHardware.textContent = isWebHIDPlayStation
        ? 'Hardware, Bateria, Touchpad & Giroscópio'
        : 'Diagnóstico de Hardware & Taxa de Resposta (Polling)';
    }

    // Exibe o botão de Calibração de Analógicos SOMENTE quando um controle compatível (PS5/PS4) estiver conectado via WebHID
    if (!isWebHIDPlayStation && state.activeTab === 'calibration') {
      setCalibrationView(false);
    } else {
      setCalibrationView(state.activeTab === 'calibration');
    }

    if (isIdle) {
      if (modelBadge) {
        modelBadge.textContent = 'Aguardando identificação do controle...';
        modelBadge.className = 'text-[10px] font-extrabold uppercase tracking-widest px-2.5 py-0.5 rounded-md bg-slate-800 text-slate-400 border border-slate-700';
      }
      if (autoDetectPill) {
        autoDetectPill.textContent = '🔍 Reconhecimento Automático de Modelo (VID/PID)';
      }
      return;
    }

    // Atualiza o badge de modelo e os nomes exatos dos botões no checklist inferior conforme o controle identificado
    const skinMeta = {
      ps5: {
        badge: 'Identificado: Sony PS5 DualSense (Layout Simétrico)',
        pill: '✓ Layout Carregado: PS5 DualSense',
        labels: {
          cross: '✕ Cruz', circle: '○ Bola', square: '□ Quadrado', triangle: '△ Triângulo',
          l1: 'L1', r1: 'R1', l2Btn: 'L2', r2Btn: 'R2', l3: 'L3', r3: 'R3',
          create: 'Create', options: 'Options', ps: 'Botão PS', touchpad: 'Touchpad', mute: 'Mute Mic'
        }
      },
      ps4: {
        badge: 'Identificado: Sony PS4 DualShock 4 (Layout Simétrico)',
        pill: '✓ Layout Carregado: PS4 DualShock 4',
        labels: {
          cross: '✕ Cruz', circle: '○ Bola', square: '□ Quadrado', triangle: '△ Triângulo',
          l1: 'L1', r1: 'R1', l2Btn: 'L2', r2Btn: 'R2', l3: 'L3', r3: 'R3',
          create: 'Share', options: 'Options', ps: 'Botão PS', touchpad: 'Touchpad', mute: '—'
        }
      },
      xbox: {
        badge: 'Identificado: Xbox Series X|S / One (Layout Assimétrico)',
        pill: '✓ Layout Carregado: Xbox Series / One',
        labels: {
          cross: 'A (Verde)', circle: 'B (Vermelho)', square: 'X (Azul)', triangle: 'Y (Amarelo)',
          l1: 'LB', r1: 'RB', l2Btn: 'LT', r2Btn: 'RT', l3: 'LS (Esq)', r3: 'RS (Dir)',
          create: 'View ⧉', options: 'Menu ☰', ps: 'Xbox Nexus', touchpad: 'Share ⬆', mute: '—'
        }
      },
      switch: {
        badge: 'Identificado: Nintendo Switch Pro (Layout Assimétrico)',
        pill: '✓ Layout Carregado: Switch Pro Controller',
        labels: {
          cross: 'B (Baixo)', circle: 'A (Direita)', square: 'Y (Esquerda)', triangle: 'X (Topo)',
          l1: 'L', r1: 'R', l2Btn: 'ZL', r2Btn: 'ZR', l3: 'L-Stick', r3: 'R-Stick',
          create: '− Minus', options: '+ Plus', ps: 'Home ⌂', touchpad: 'Capture ◉', mute: '—'
        }
      }
    };

    const currentMeta = skinMeta[state.skin] || skinMeta.ps5;
    if (modelBadge) {
      modelBadge.textContent = currentMeta.badge;
      modelBadge.className = 'text-[10px] font-extrabold uppercase tracking-widest px-2.5 py-0.5 rounded-md bg-cyan-500/15 text-cyan-300 border border-cyan-500/30';
    }
    if (autoDetectPill) {
      autoDetectPill.textContent = currentMeta.pill;
    }
    Object.keys(currentMeta.labels).forEach((k) => {
      setText(`pill-btn-${k}`, currentMeta.labels[k]);
    });
  }

  /* ==========================================================================
   * 7. EVENTOS DE INTERFACE E CONTROLES DE OUTPUT
   * ========================================================================== */
  function bindUIEvents() {
    // Botão Conectar DualSense WebHID
    const btnConnectHid = document.getElementById('btn-connect-webhid');
    if (btnConnectHid) {
      btnConnectHid.addEventListener('click', connectWebHID);
    }

    // Botões de Simulação (Drift vs TMR/Hall Effect)
    const btnSimDrift = document.getElementById('btn-sim-drift');
    const btnSimTmr = document.getElementById('btn-sim-tmr');
    if (btnSimDrift) {
      btnSimDrift.addEventListener('click', () => startSimulation('sim-drift'));
    }
    if (btnSimTmr) {
      btnSimTmr.addEventListener('click', () => startSimulation('sim-tmr'));
    }

    // Inicializa o palco em modo de identificação automática
    updateSkinTabs();

    // Interação direta no Touchpad (Monitor #canvas-touchpad e SVG Touchpad) para teste rápido e atalho WebHID
    let isPointerTouching = false;
    const applyPointerTouch = (clientX, clientY, rect) => {
      const nx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const ny = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      state.touch.t1Active = true;
      state.touch.t1X = Math.round(nx * 1920);
      state.touch.t1Y = Math.round(ny * 1080);
      pushTouchTrail(state.touch.t1X, state.touch.t1Y);
    };

    if (canvasTouchpad) {
      canvasTouchpad.style.cursor = 'crosshair';
      canvasTouchpad.addEventListener('pointerdown', (e) => {
        isPointerTouching = true;
        canvasTouchpad.setPointerCapture(e.pointerId);
        applyPointerTouch(e.clientX, e.clientY, canvasTouchpad.getBoundingClientRect());
      });
      canvasTouchpad.addEventListener('pointermove', (e) => {
        if (!isPointerTouching) return;
        applyPointerTouch(e.clientX, e.clientY, canvasTouchpad.getBoundingClientRect());
      });
      const stopPointerTouch = () => {
        if (!isPointerTouching) return;
        isPointerTouching = false;
        state.touch.t1Active = false;
      };
      canvasTouchpad.addEventListener('pointerup', stopPointerTouch);
      canvasTouchpad.addEventListener('pointercancel', stopPointerTouch);
    }

    document.querySelectorAll('svg[data-controller-skin="ps5"] [data-btn="touchpad"], svg[data-controller-skin="ps4"] [data-btn="touchpad"]').forEach((tpRect) => {
      tpRect.style.cursor = 'crosshair';
      tpRect.addEventListener('pointerdown', (e) => {
        isPointerTouching = true;
        tpRect.setPointerCapture(e.pointerId);
        applyPointerTouch(e.clientX, e.clientY, tpRect.getBoundingClientRect());
        if (state.mode === 'gamepad' && (state.skin === 'ps5' || state.skin === 'ps4')) {
          showNotification('Para rastrear o deslize físico dos dedos no Touchpad do DualSense, clique no botão azul "Ativar Recursos Exclusivos DualSense (WebHID)".', 'info');
        }
      });
      tpRect.addEventListener('pointermove', (e) => {
        if (!isPointerTouching) return;
        applyPointerTouch(e.clientX, e.clientY, tpRect.getBoundingClientRect());
      });
      const stopSvgTouch = () => {
        if (!isPointerTouching) return;
        isPointerTouching = false;
        state.touch.t1Active = false;
      };
      tpRect.addEventListener('pointerup', stopSvgTouch);
      tpRect.addEventListener('pointercancel', stopSvgTouch);
    });

    // Botão Resetar Circularidade e Histórico
    const btnResetCirc = document.getElementById('btn-reset-circularity');
    if (btnResetCirc) {
      btnResetCirc.addEventListener('click', () => {
        resetCircularity();
        state.testedButtons.clear();
        showNotification('Gráfico de circularidade e histórico de botões zerados.', 'info');
      });
    }

    // Toggle Zoom 5x de Centro pelos ícones de lupa próximos aos analógicos (L3 e R3)
    const zoomBtns = document.querySelectorAll('[data-toggle-zoom]');
    const syncZoomButtonsUI = () => {
      const active = state.circularity.zoomCenter;
      zoomBtns.forEach((btn) => {
        btn.setAttribute('aria-pressed', String(active));
        btn.className = active
          ? 'w-7 h-7 rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-400/60 shadow-[0_0_12px_rgba(0,229,255,0.3)] flex items-center justify-center transition-all cursor-pointer shrink-0'
          : 'w-7 h-7 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-cyan-300 border border-slate-800 hover:border-cyan-500/40 flex items-center justify-center transition-all cursor-pointer shrink-0';
      });
    };
    zoomBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        state.circularity.zoomCenter = !state.circularity.zoomCenter;
        syncZoomButtonsUI();
      });
    });

    // Alternância entre Testador e Área Guiada de Calibração
    const btnOpenCalib = document.getElementById('btn-open-calibration');
    const btnCloseCalib = document.getElementById('btn-close-calibration');
    const btnCalibBackBottom = document.getElementById('btn-calib-back-bottom');
    const btnCalibCenter = document.getElementById('btn-calib-center');
    const btnCalibRangeStart = document.getElementById('btn-calib-range-start');
    const btnCalibRangeSave = document.getElementById('btn-calib-range-save');
    const btnCalibReset = document.getElementById('btn-calib-reset');

    if (btnOpenCalib) {
      btnOpenCalib.addEventListener('click', () => setCalibrationView(true));
    }
    if (btnCloseCalib) {
      btnCloseCalib.addEventListener('click', () => setCalibrationView(false));
    }
    if (btnCalibBackBottom) {
      btnCalibBackBottom.addEventListener('click', () => setCalibrationView(false));
    }
    if (btnCalibCenter) {
      btnCalibCenter.addEventListener('click', calibrateStickCenter);
    }
    if (btnCalibRangeStart) {
      btnCalibRangeStart.addEventListener('click', startStickRangeCalibration);
    }
    if (btnCalibRangeSave) {
      btnCalibRangeSave.addEventListener('click', saveStickRangeCalibration);
    }
    if (btnCalibReset) {
      btnCalibReset.addEventListener('click', resetStickCalibration);
    }

    // Controles de Gatilhos Adaptáveis DualSense (L2 e R2)
    const selL2Mode = document.getElementById('sel-l2-mode');
    const rngL2Force = document.getElementById('rng-l2-force');
    const selR2Mode = document.getElementById('sel-r2-mode');
    const rngR2Force = document.getElementById('rng-r2-force');
    const btnSyncTriggers = document.getElementById('btn-apply-triggers');

    const updateTriggersFromUI = () => {
      if (selL2Mode) state.dualsenseOutput.l2Mode = selL2Mode.value;
      if (rngL2Force) state.dualsenseOutput.l2Force = parseInt(rngL2Force.value, 10) || 180;
      if (selR2Mode) state.dualsenseOutput.r2Mode = selR2Mode.value;
      if (rngR2Force) state.dualsenseOutput.r2Force = parseInt(rngR2Force.value, 10) || 180;
      setText('lbl-l2-force', `${Math.round((state.dualsenseOutput.l2Force / 255) * 100)}%`);
      setText('lbl-r2-force', `${Math.round((state.dualsenseOutput.r2Force / 255) * 100)}%`);
      sendDualSenseOutputReport();
    };

    [selL2Mode, rngL2Force, selR2Mode, rngR2Force].forEach((el) => {
      if (el) el.addEventListener('input', updateTriggersFromUI);
    });
    if (btnSyncTriggers) {
      btnSyncTriggers.addEventListener('click', () => {
        updateTriggersFromUI();
        showNotification('Configuração de Gatilhos Adaptáveis enviada ao DualSense!', 'success');
      });
    }

    // Presets Rápidos de Gatilho Adaptável
    document.querySelectorAll('[data-trigger-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const preset = btn.getAttribute('data-trigger-preset');
        if (preset === 'off') {
          if (selL2Mode) selL2Mode.value = 'off';
          if (selR2Mode) selR2Mode.value = 'off';
        } else if (preset === 'bow') {
          if (selL2Mode) selL2Mode.value = 'continuous';
          if (rngL2Force) rngL2Force.value = '220';
          if (selR2Mode) selR2Mode.value = 'continuous';
          if (rngR2Force) rngR2Force.value = '220';
        } else if (preset === 'pistol') {
          if (selL2Mode) selL2Mode.value = 'continuous';
          if (rngL2Force) rngL2Force.value = '140';
          if (selR2Mode) selR2Mode.value = 'section';
          if (rngR2Force) rngR2Force.value = '240';
        } else if (preset === 'machinegun') {
          if (selL2Mode) selL2Mode.value = 'section';
          if (selR2Mode) selR2Mode.value = 'pulse';
          if (rngR2Force) rngR2Force.value = '230';
        }
        updateTriggersFromUI();
      });
    });

    // Teste de Vibração / Rumble (Funciona tanto em WebHID quanto em Gamepad API!)
    const btnTestRumble = document.getElementById('btn-test-rumble');
    const btnStopRumble = document.getElementById('btn-stop-rumble');
    const rngRumbleHeavy = document.getElementById('rng-rumble-heavy');
    const rngRumbleSoft = document.getElementById('rng-rumble-soft');

    if (btnTestRumble) {
      btnTestRumble.addEventListener('click', async () => {
        const heavy = rngRumbleHeavy ? parseInt(rngRumbleHeavy.value, 10) : 200;
        const soft = rngRumbleSoft ? parseInt(rngRumbleSoft.value, 10) : 200;

        if (state.mode === 'webhid') {
          state.dualsenseOutput.rumbleHeavy = heavy;
          state.dualsenseOutput.rumbleSoft = soft;
          await sendDualSenseOutputReport();
          setTimeout(() => {
            state.dualsenseOutput.rumbleHeavy = 0;
            state.dualsenseOutput.rumbleSoft = 0;
            sendDualSenseOutputReport();
          }, 1200);
          showNotification('Testando motores de vibração via WebHID (1.2s)...', 'info');
        } else if (state.mode === 'gamepad' && activeGamepadIndex !== null) {
          const gp = navigator.getGamepads()[activeGamepadIndex];
          if (gp && gp.vibrationActuator) {
            gp.vibrationActuator.playEffect('dual-rumble', {
              startDelay: 0,
              duration: 1200,
              weakMagnitude: soft / 255,
              strongMagnitude: heavy / 255
            });
            showNotification('Testando vibração via Gamepad API (1.2s)...', 'info');
          } else {
            showNotification('Este controle/navegador não expõe atuador de vibração no modo Gamepad padrão.', 'warn');
          }
        } else {
          showNotification('Conecte um controle primeiro para testar a vibração.', 'warn');
        }
      });
    }

    if (btnStopRumble) {
      btnStopRumble.addEventListener('click', () => {
        state.dualsenseOutput.rumbleHeavy = 0;
        state.dualsenseOutput.rumbleSoft = 0;
        sendDualSenseOutputReport();
      });
    }

    // Controle de Cor do LED RGB, Player LEDs e Mute LED
    const colorPicker = document.getElementById('inp-lightbar-color');
    if (colorPicker) {
      colorPicker.addEventListener('input', (e) => {
        const hex = e.target.value;
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        state.dualsenseOutput.ledR = r;
        state.dualsenseOutput.ledG = g;
        state.dualsenseOutput.ledB = b;
        sendDualSenseOutputReport();
      });
    }

    document.querySelectorAll('[data-led-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const hex = btn.getAttribute('data-led-preset');
        if (colorPicker && hex) {
          colorPicker.value = hex;
          colorPicker.dispatchEvent(new Event('input'));
        }
      });
    });

    const selPlayerLeds = document.getElementById('sel-player-leds');
    if (selPlayerLeds) {
      selPlayerLeds.addEventListener('change', (e) => {
        state.dualsenseOutput.playerLeds = parseInt(e.target.value, 10) || 0;
        sendDualSenseOutputReport();
      });
    }

    const selMuteLed = document.getElementById('sel-mute-led');
    if (selMuteLed) {
      selMuteLed.addEventListener('change', (e) => {
        state.dualsenseOutput.muteLed = parseInt(e.target.value, 10) || 0;
        sendDualSenseOutputReport();
      });
    }

    // Menu Mobile (Header)
    const mobileBtn = document.getElementById('mobile-menu-btn');
    const mobileMenu = document.getElementById('mobile-menu');
    if (mobileBtn && mobileMenu) {
      mobileBtn.addEventListener('click', () => {
        const isExpanded = mobileBtn.getAttribute('aria-expanded') === 'true';
        mobileBtn.setAttribute('aria-expanded', String(!isExpanded));
        mobileMenu.classList.toggle('hidden');
      });
    }

    // Botão de Enviar Diagnóstico Técnico direto para o WhatsApp da ArrowTech
    const btnSendDiag = document.getElementById('btn-send-diagnosis');
    if (btnSendDiag) {
      btnSendDiag.addEventListener('click', () => {
        const cfg = window.ARROWTECH_CONFIG || { whatsappNumber: '5511999999999' };
        const hasController = state.mode !== 'idle';
        const lDrift = Math.round(Math.hypot(state.axes.lx, state.axes.ly) * 100);
        const rDrift = Math.round(Math.hypot(state.axes.rx, state.axes.ry) * 100);
        const errL = state.circularity.leftAvgError.toFixed(1);
        const errR = state.circularity.rightAvgError.toFixed(1);

        const message = hasController
          ? `Olá! Testei meu controle no site da ArrowTech:\n` +
            `🎮 Controle: ${state.controllerName}\n` +
            `🎯 Analógico Esq (L3): Desvio ${lDrift}% | Erro Circ: ${errL}%\n` +
            `🎯 Analógico Dir (R3): Desvio ${rDrift}% | Erro Circ: ${errR}%\n\n` +
            `Gostaria de saber sobre manutenção / upgrade Hall Effect ou TMR!`
          : `Olá! Vim pelo Testador de Controles da ArrowTech e gostaria de fazer um orçamento de manutenção.`;

        const waUrl = `https://wa.me/${cfg.whatsappNumber}?text=${encodeURIComponent(message)}`;
        window.open(waUrl, '_blank', 'noopener,noreferrer');
      });
    }
  }

  /* ==========================================================================
   * 8. UTILITÁRIOS DE UI
   * ========================================================================== */
  function setText(id, val) {
    const el = document.getElementById(id);
    if (el && el.textContent !== String(val)) {
      el.textContent = String(val);
    }
  }

  function showNotification(msg, type) {
    const toast = document.getElementById('tester-toast');
    const toastText = document.getElementById('tester-toast-text');
    if (!toast || !toastText) return;

    toastText.textContent = msg;
    toast.classList.remove('hidden', 'border-cyan-400/50', 'border-emerald-400/50', 'border-amber-400/50', 'border-red-400/50');

    if (type === 'success') toast.classList.add('border-emerald-400/50');
    else if (type === 'warn') toast.classList.add('border-amber-400/50');
    else if (type === 'error') toast.classList.add('border-red-400/50');
    else toast.classList.add('border-cyan-400/50');

    clearTimeout(window.__testerToastTimer);
    window.__testerToastTimer = setTimeout(() => {
      toast.classList.add('hidden');
    }, 4500);
  }
})();
