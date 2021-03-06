'use strict';

const shell = require('shelljs');

const originPassphrase = 'testtest',
  auxiliaryPassphrase = 'testtest';

const Mosaic = require('../index');

const OSTPrimeGatewayDeployer = function(config, configOutputPath) {
  const oThis = this;

  oThis.configJsonFilePath = configOutputPath;
  oThis.config = config;

  let mosaicConfig = oThis._mosaicConfig();

  oThis.mosaic = new Mosaic('', mosaicConfig);
  oThis.setSigner();
};

OSTPrimeGatewayDeployer.prototype = {
  setSigner: function() {
    //We will use the geth Signer here.
    let oThis = this,
      mosaic = oThis.mosaic,
      config = oThis.config;

    let originGethSigner = new mosaic.utils.GethSignerService(config.originGethRpcEndPoint);
    originGethSigner.addAccount(config.originDeployerAddress, originPassphrase);

    mosaic.signers.setOriginSignerService(originGethSigner);

    let auxiliaryGethSigner = new mosaic.utils.GethSignerService(config.auxiliaryGethRpcEndPoint);
    auxiliaryGethSigner.addAccount(config.auxiliaryDeployerAddress, auxiliaryPassphrase);

    mosaic.signers.setAuxiliarySignerService(auxiliaryGethSigner, config.originCoreContractAddress);
  },
  deploy: async function() {
    const oThis = this;
    let config = oThis.config;

    let originConfig = this._originConfig(config),
      //auxiliary
      auxiliaryConfig = this._auxiliaryConfig(config);

    let deployResult = await oThis.mosaic.setup.deployGateway(originConfig, auxiliaryConfig),
      gatewayAddress = deployResult.gateway.receipt.contractAddress,
      coGatewayAddress = deployResult.cogateway.receipt.contractAddress;

    console.log(` gateway ${gatewayAddress} , co-gateway ${coGatewayAddress}`);
    oThis._addConfig({
      gatewayAddress: gatewayAddress,
      coGatewayAddress: coGatewayAddress
    });
  },

  _addConfig: function(params) {
    const oThis = this;

    let config = oThis.config;
    Object.assign(config, params);

    oThis._executeInShell("echo '" + JSON.stringify(config, null, 2) + "' > " + oThis.configJsonFilePath);
  },

  _executeInShell: function(cmd) {
    let res = shell.exec(cmd);

    if (res.code !== 0) {
      shell.exit(1);
    }

    return res;
  },

  _originConfig: function(config) {
    return {
      coreAddress: config.originCoreContractAddress,
      deployerAddress: config.originDeployerAddress,
      deployerPassPhrase: originPassphrase,
      gasPrice: config.originGasPrice,
      gasLimit: config.originGasLimit,
      token: config.originERC20TokenContractAddress,
      bounty: 0,
      organisationAddress: config.originOrganizationAddress,
      messageBusAddress: config.originMessageBusContractAddress
    };
  },
  _auxiliaryConfig: function(config) {
    return {
      coreAddress: config.auxiliaryCoreContractAddress,
      deployerAddress: config.auxiliaryDeployerAddress,
      deployerPassPhrase: auxiliaryPassphrase,
      gasPrice: 0, // deploying with zero gas
      gasLimit: config.auxiliaryGasLimit,
      token: config.auxiliaryERC20TokenContractAddress,
      bounty: 0,
      organisationAddress: config.auxiliaryOrganizationAddress,
      messageBusAddress: config.auxiliaryMessageBusContractAddress
    };
  },
  _mosaicConfig: function() {
    let oThis = this;

    return {
      origin: {
        provider: oThis.config.originGethRpcEndPoint
      },
      auxiliaries: [
        {
          provider: oThis.config.auxiliaryGethRpcEndPoint,
          originCoreContractAddress: oThis.config.originCoreContractAddress
        }
      ]
    };
  }
};

module.exports = OSTPrimeGatewayDeployer;
