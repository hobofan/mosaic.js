const InstanceComposer = require('../../instance_composer'),
  HashLock = require('../../utils/HashLock'),
  Proof = require('../../tools/proof/proof_generator'),
  Rsync = require('../../tools/sync/sync');

const ORIGIN_GAS_PRICE = 0,
  ORIGIN_GAS_LIMIT = 4700000,
  AUXILIARY_GAS_PRICE = 0,
  AUXLILIARY_GAS_LIMIT = 4700000,
  PASSPHRASE = 'testtest';

const StakeAndMint = function(config) {
  const oThis = this;

  oThis.config = config;
  oThis.gatewayAddress = config.gatewayAddress;
  oThis.coGatewayAddress = config.coGatewayAddress;
  oThis.originCoreAddress = config.originCoreContractAddress;
  oThis.originFacilitator = config.originDeployerAddress;
  oThis.auxiliaryFacilitator = config.auxiliaryDeployerAddress;

  oThis.originOptions = {
    from: oThis.originFacilitator,
    gas: ORIGIN_GAS_LIMIT,
    gasPrice: ORIGIN_GAS_PRICE
  };

  oThis.auxiliaryOptions = {
    from: oThis.auxiliaryFacilitator,
    gas: AUXLILIARY_GAS_LIMIT,
    gasPrice: AUXILIARY_GAS_PRICE
  };

  const ERC20Gateway = oThis.ic().ERC20Gateway(),
    MockToken = oThis.ic().MockToken(),
    Core = oThis.ic().Core();

  oThis.erc20Gateway = new ERC20Gateway(
    oThis.gatewayAddress,
    oThis.originOptions,
    oThis.originCoreAddress,
    oThis.coGatewayAddress,
    oThis.auxiliaryOptions
  );

  oThis.mockToken = new MockToken(
    config.originERC20TokenContractAddress,
    {
      from: config.originDeployerAddress,
      gas: ORIGIN_GAS_LIMIT,
      gasPrice: ORIGIN_GAS_PRICE
    },
    config.originCoreContractAddress
  );

  oThis.core = new Core(
    config.originCoreContractAddress,
    {
      from: config.originWorkerAddress,
      gas: ORIGIN_GAS_LIMIT,
      gasPrice: ORIGIN_GAS_PRICE
    },
    config.auxiliaryCoreContractAddress,
    {
      from: config.auxiliaryWorkerAddress,
      gas: AUXLILIARY_GAS_LIMIT,
      gasPrice: AUXILIARY_GAS_PRICE
    }
  );

  oThis.rsync = new Rsync({ path: config.originChainDataPath }, { path: config.originChainDataSyncPath });
};

StakeAndMint.prototype = {
  perform: async function() {
    const oThis = this;

    const stakeAmount = 100000000000000,
      staker = oThis.config.originDeployerAddress,
      beneficiary = oThis.config.auxiliaryOrganizationAddress,
      gasPrice = 100;

    console.info('---------------------------------------------');
    console.info(`Approving Gateway for ${stakeAmount} by staker ${staker}`);
    let approveResponse = await oThis._approve(oThis.gatewayAddress, stakeAmount, staker);
    if (approveResponse.events.Approval instanceof Object) {
      console.info(`Approve Gateway successful`);
    } else {
      console.error(`Approve Gateway failed`);
      console.error('approveResponse: ', approveResponse);
      let err = new Error(`Approve Gateway failed`);
      throw err;
    }

    console.info('---------------------------------------------');
    console.info(`Getting nonce for staker address: ${staker}`);
    let nonce = await oThis._getNonce(staker);
    console.log('nonce: ', nonce);
    console.info('---------------------------------------------');

    console.info(`Preparing intent hash for the given input params`);
    let intentHash = await oThis._intentHash(stakeAmount, beneficiary, staker, gasPrice);
    console.log('intentHash: ', intentHash);
    console.info('---------------------------------------------');

    console.info(`Generating hashLock and unlockSecrete`);
    let hashLock = oThis._generateHashLock();
    console.log('hashLock: ', hashLock);
    console.info('---------------------------------------------');

    console.info(`Signing the messageDigest`);
    const signature = await oThis._signHash(intentHash, nonce, staker, gasPrice);
    console.log('signature: ', signature);
    console.info('---------------------------------------------');

    console.info(`Querying the bounty`);
    const bounty = await oThis._getBounty();
    console.log('bounty: ', bounty);
    console.info('---------------------------------------------');

    console.info(`generating the messageHash`);
    const messageHash = await oThis._stakeCall(
      stakeAmount,
      beneficiary,
      staker,
      gasPrice,
      nonce,
      hashLock.l,
      signature,
      bounty
    );
    console.log('messageHash: ', messageHash);
    console.info('---------------------------------------------');

    console.info(`Starting staking process`);
    const stakeResponse = await oThis._stake(
      stakeAmount,
      beneficiary,
      staker,
      gasPrice,
      nonce,
      hashLock.l,
      signature,
      bounty
    );
    if (stakeResponse.events.StakeRequestedEvent instanceof Object) {
      console.info(`Success !!!`);
    } else {
      console.error(`Failed !!!`);
      console.error('stakeResponse: ', stakeResponse);
      let err = new Error(`Stake failed`);
      throw err;
    }
    console.info('---------------------------------------------');

    console.info(`Getting the stateRoot`);
    let originWeb3 = new (oThis.ic().OriginWeb3())();
    const stateRoot = await oThis._getStateRoot(stakeResponse, originWeb3);
    console.log('stateRoot: ', stateRoot);
    console.info('---------------------------------------------');

    console.info(`Commiting the state root ${stateRoot} for blockHeight ${stakeResponse.blockNumber}`);
    const commitStateRootResponse = await oThis._commitStateRootOnAuxiliary(stakeResponse.blockNumber, stateRoot);

    if (commitStateRootResponse.events.StateRootCommitted instanceof Object) {
      console.info(`Success !!!`);
    } else {
      console.error(`Failed !!!`);
      console.error('commitStateRootResponse: ', commitStateRootResponse);
      let err = new Error(`Commit stateRoot failed`);
      throw err;
    }
    console.info('---------------------------------------------');

    console.info(`Performing rSync`);
    await oThis.rsync.perform();
    console.log('RSYNC done, generating proof');
    console.info('---------------------------------------------');

    console.info(`Generating account proof for gateway ${oThis.gatewayAddress}`);
    let proof = new Proof(stateRoot, config.originChainDataSyncPath + '/chaindata');
    let gatewayProof = await proof.buildAccountProof(oThis.gatewayAddress.slice(2)).catch((error) => {
      console.log('gatewayProof error: ', error);
      throw error;
    });

    console.log('gatewayProof: ', gatewayProof);
    console.info('---------------------------------------------');

    let rlpEncodedAccount = gatewayProof.value,
      rlpParentNodes = gatewayProof.parentNodes;

    console.info(`Proving gateway ${oThis.gatewayAddress}`);
    const proveGateway = await oThis._proveGateway(stakeResponse.blockNumber, rlpEncodedAccount, rlpParentNodes);
    console.log('proveGateway: ', proveGateway);

    if (proveGateway.events.GatewayProven instanceof Object) {
      console.info(`Success !!!`);
    } else {
      console.error(`Failed !!!`);
      console.error('proveGatewayResponse: ', proveGateway);
      let err = new Error(`Prove gateway failed`);
      throw err;
    }

    console.info('---------------------------------------------');
    oThis.gatewayOutBoxPosition = '1';

    console.info(`Building message outbox storage proof for message hash ${messageHash}`);

    let storageProof = await proof.buildStorageProof(oThis.gatewayAddress.slice(2), oThis.gatewayOutBoxPosition, [
      messageHash
    ]);

    console.log('storageProof: ', storageProof);
    console.info('---------------------------------------------');

    rlpParentNodes = storageProof[messageHash].parentNodes;

    console.info(`Confirming StakingIntent on CoGateway`);

    let confirmStakingIntentHashResponse = await oThis._confirmStakingIntentHash(
      staker,
      nonce,
      beneficiary,
      stakeAmount,
      gasPrice,
      stakeResponse.blockNumber,
      hashLock.l,
      rlpParentNodes
    );
    if (confirmStakingIntentHashResponse.events.StakingIntentConfirmed instanceof Object) {
      console.info(`Success !!!`);
    } else {
      console.error(`Failed !!!`);
      console.error('confirmStakingIntentHashResponse: ', confirmStakingIntentHashResponse);
      let err = new Error(`ConfirmStakingIntent failed`);
      throw err;
    }

    console.info('---------------------------------------------');

    console.info(`ProcessStaking on Gateway`);

    const processStakingResponse = await oThis._processStaking(messageHash, hashLock.s);
    if (processStakingResponse.events.StakeProcessed instanceof Object) {
      console.info(`Success !!!`);
    } else {
      console.error(`Failed !!!`);
      console.error('processStakingResponse: ', processStakingResponse);
      let err = new Error(`processStaking failed`);
      throw err;
    }

    console.info('---------------------------------------------');
    console.info(`processMinting on CoGateway`);

    const processMintingResponse = await oThis._processMinting(messageHash, hashLock.s);
    if (processMintingResponse.events.MintProcessed instanceof Object) {
      console.info(`Success !!!`);
      console.info(`********* Stake and Mint Done ***********`);
    } else {
      console.error(`Failed !!!`);
      console.error('processMintingResponse: ', processMintingResponse);
      let err = new Error(`processMinting failed`);
      throw err;
    }
  },

  _getMosaicConfig: function(configs) {
    return {
      origin: {
        provider: configs.originGethRpcEndPoint
      },
      auxiliaries: [
        {
          provider: configs.auxiliaryGethRpcEndPoint,
          originCoreContractAddress: configs.originCoreContractAddress
        }
      ]
    };
  },

  _signHash: async function(hash, nonce, signer, gasPrice) {
    const oThis = this;

    let typeHash = await oThis.erc20Gateway.origin.stakeRequestTypeHash().call({
      from: oThis.originFacilitator,
      gas: ORIGIN_GAS_LIMIT,
      gasPrice: ORIGIN_GAS_PRICE
    });

    let originWeb3 = new (oThis.ic().OriginWeb3())();

    let digest = originWeb3.utils.soliditySha3(
      { t: 'bytes32', v: typeHash },
      { t: 'bytes32', v: hash },
      { t: 'uint256', v: nonce },
      { t: 'uint256', v: gasPrice }
    );

    return await originWeb3.eth.sign(digest, signer);
  },

  _approve: async function(address, amount, sender) {
    // approve gateway
    const oThis = this;

    // unlock account
    await oThis._unlockAccountOnOrigin(sender, PASSPHRASE);

    return oThis.mockToken.origin
      .approve(address, amount)
      .send({
        from: sender,
        gas: ORIGIN_GAS_LIMIT,
        gasPrice: ORIGIN_GAS_PRICE
      })
      .once('error', function(error) {
        Promise.reject(error);
      })
      .once('receipt', function(receipt) {
        Promise.resolve(receipt);
      })
      .once('transactionHash', function(transactionHash) {
        console.log('transactionHash: ', transactionHash);
      });
  },

  _getNonce: async function(address) {
    const oThis = this;
    const nonce = await oThis.erc20Gateway.origin.getNonce(address).call({
      from: oThis.config.originDeployerAddress,
      gas: ORIGIN_GAS_LIMIT,
      gasPrice: ORIGIN_GAS_PRICE
    });
    return nonce;
  },

  _getBounty: async function() {
    const oThis = this;
    const bounty = await oThis.erc20Gateway.origin.bounty().call({
      from: oThis.config.originDeployerAddress,
      gas: ORIGIN_GAS_LIMIT,
      gasPrice: ORIGIN_GAS_PRICE
    });
    return bounty;
  },

  _intentHash: async function(stakeAmount, beneficiary, staker, gasPrice) {
    const oThis = this;
    const intentHash = await oThis.erc20Gateway.origin
      .hashStakingIntent(stakeAmount, beneficiary, staker, gasPrice)
      .call({
        from: oThis.config.originDeployerAddress,
        gas: ORIGIN_GAS_LIMIT,
        gasPrice: ORIGIN_GAS_PRICE
      });
    return intentHash;
  },

  _generateHashLock: function() {
    let hs = new HashLock();
    return hs.getHashLock();
  },

  _stakeCall: async function(amount, beneficiary, staker, gasPrice, nonce, hashLock, signature, bounty) {
    const oThis = this;

    let stakeResponse = await oThis.erc20Gateway
      .stake(amount, beneficiary, staker, gasPrice, nonce, hashLock, signature)
      .call({
        from: oThis.originFacilitator,
        gas: ORIGIN_GAS_LIMIT,
        gasPrice: ORIGIN_GAS_PRICE,
        value: bounty
      });

    return stakeResponse;
  },

  _stake: async function(amount, beneficiary, staker, gasPrice, nonce, hashLock, signature, bounty) {
    const oThis = this;

    // unlock account
    await oThis._unlockAccountOnOrigin(oThis.originFacilitator, PASSPHRASE);

    return oThis.erc20Gateway
      .stake(amount, beneficiary, staker, gasPrice, nonce, hashLock, signature)
      .send({
        from: oThis.originFacilitator,
        gas: ORIGIN_GAS_LIMIT,
        gasPrice: ORIGIN_GAS_PRICE,
        value: bounty
      })
      .once('error', function(error) {
        Promise.reject(error);
      })
      .once('receipt', function(receipt) {
        Promise.resolve(receipt);
      })
      .once('transactionHash', function(transactionHash) {
        console.log('transactionHash: ', transactionHash);
      });
  },

  _processStaking: async function(messageHash, unlockSecret) {
    const oThis = this;

    // unlock account
    await oThis._unlockAccountOnAuxiliary(oThis.auxiliaryFacilitator, PASSPHRASE);

    return oThis.erc20Gateway
      .processStaking(messageHash, unlockSecret)
      .send({
        from: oThis.originFacilitator,
        gas: AUXLILIARY_GAS_LIMIT,
        gasPrice: AUXILIARY_GAS_PRICE
      })
      .once('error', function(error) {
        Promise.reject(error);
      })
      .once('receipt', function(receipt) {
        Promise.resolve(receipt);
      })
      .once('transactionHash', function(transactionHash) {
        console.log('transactionHash: ', transactionHash);
      });
  },

  _getStateRoot: async function(receipt, web3) {
    const oThis = this;
    let block = await web3.eth.getBlock(receipt.blockNumber);
    return block.stateRoot;
  },

  _commitStateRootOnAuxiliary: async function(blockHeight, stateRoot) {
    let oThis = this;

    // unlock account
    await oThis._unlockAccountOnAuxiliary(oThis.config.auxiliaryWorkerAddress, PASSPHRASE);

    return oThis.core.auxiliary
      .commitStateRoot(blockHeight, stateRoot)
      .send({
        from: oThis.config.auxiliaryWorkerAddress,
        gas: AUXLILIARY_GAS_LIMIT,
        gasPrice: AUXILIARY_GAS_PRICE
      })
      .once('error', function(error) {
        Promise.reject(error);
      })
      .once('receipt', function(receipt) {
        Promise.resolve(receipt);
      })
      .once('transactionHash', function(transactionHash) {
        console.log('transactionHash: ', transactionHash);
      });
  },

  _proveGateway: async function(blockHeight, rlpEncodedAccount, rlpParentNodes) {
    const oThis = this;

    // unlock account
    await oThis._unlockAccountOnAuxiliary(oThis.auxiliaryFacilitator, PASSPHRASE);

    return oThis.erc20Gateway.auxiliary
      .proveGateway(blockHeight, rlpEncodedAccount, rlpParentNodes)
      .send({
        from: oThis.config.auxiliaryWorkerAddress,
        gas: AUXLILIARY_GAS_LIMIT,
        gasPrice: AUXILIARY_GAS_PRICE
      })
      .once('error', function(error) {
        Promise.reject(error);
      })
      .once('receipt', function(receipt) {
        Promise.resolve(receipt);
      })
      .once('transactionHash', function(transactionHash) {
        console.log('transactionHash: ', transactionHash);
      });
  },

  _confirmStakingIntentHash: async function(
    staker,
    stakerNonce,
    beneficiary,
    amount,
    gasPrice,
    blockHeight,
    hashLock,
    rlpParentNodes
  ) {
    const oThis = this;

    // unlock account
    await oThis._unlockAccountOnAuxiliary(oThis.auxiliaryFacilitator, PASSPHRASE);

    return oThis.erc20Gateway
      .confirmStakingIntent(staker, stakerNonce, beneficiary, amount, gasPrice, blockHeight, hashLock, rlpParentNodes)
      .send({
        from: oThis.auxiliaryFacilitator,
        gas: AUXLILIARY_GAS_LIMIT,
        gasPrice: AUXILIARY_GAS_PRICE
      })
      .once('error', function(error) {
        Promise.reject(error);
      })
      .once('receipt', function(receipt) {
        Promise.resolve(receipt);
      })
      .once('transactionHash', function(transactionHash) {
        console.log('transactionHash: ', transactionHash);
      });
  },

  _processMinting: async function(messageHash, unlockSecret) {
    const oThis = this;

    // unlock account
    await oThis._unlockAccountOnAuxiliary(oThis.auxiliaryFacilitator, PASSPHRASE);

    return oThis.erc20Gateway
      .processMinting(messageHash, unlockSecret)
      .send({
        from: oThis.auxiliaryFacilitator,
        gas: AUXLILIARY_GAS_LIMIT,
        gasPrice: AUXILIARY_GAS_PRICE
      })
      .once('error', function(error) {
        Promise.reject(error);
      })
      .once('receipt', function(receipt) {
        Promise.resolve(receipt);
      })
      .once('transactionHash', function(transactionHash) {
        console.log('transactionHash: ', transactionHash);
      });
  },

  _unlockAccountOnOrigin: async function(account, passphrase) {
    const oThis = this;
    let originWeb3 = new (oThis.ic().OriginWeb3())();
    await originWeb3.eth.personal.unlockAccount(account, passphrase);
  },

  _unlockAccountOnAuxiliary: async function(account, passphrase) {
    const oThis = this;
    let auxiliaryWeb3 = new (oThis.ic().AuxiliaryWeb3())(oThis.originCoreAddress);
    await auxiliaryWeb3.eth.personal.unlockAccount(account, passphrase);
  }
};

InstanceComposer.registerShadowableClass(StakeAndMint, 'StakeAndMint');

module.exports = StakeAndMint;
