const { ethers } = require('ethers');
const {
  keomABI,
  unitrollerABI,
  erc20ABI,
  oracleABI,
  preminingABI,
} = require('./Abis');
const { PROVIDERS } = require('./Provider');
const sdk = require('@defillama/sdk');
const axios = require('axios');
const decimals = ethers.utils.parseEther("1");
const BN = ethers.BigNumber.from;

const chains = {
  polygon: {
    comptroller: '0x5B7136CFFd40Eee5B882678a5D02AA25A48d669F',
    oracle: '0x17feC0DD2c6BC438Fd65a1d2c53319BEA130BEFb',
    wnative: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
  },
  polygon_zkevm: {
    comptroller: '0x6EA32f626e3A5c41547235ebBdf861526e11f482',
    oracle: '0x483aDB7c100F1E19369a7a33c80709cfdd124c4e',
    wnative: '0x4F9A0e7FD2Bf6067db6994CF12E4495Df938E6e9',
  },
  manta: {
    comptroller: '0x91e9e99AC7C39d5c057F83ef44136dFB1e7adD7d',
    oracle: '0xfD01946C35C98D71A355B8FF18d9E1697b2dd2Ea',
    wnative: '0x0Dc808adcE2099A9F62AA87D9670745AbA741746',
  },
  isolated_manta_wusdm: {
    comptroller: '0x014991ec771aD943A487784cED965Af214FD253C',
    oracle: '0xfD01946C35C98D71A355B8FF18d9E1697b2dd2Ea',
    wnative: '0x0Dc808adcE2099A9F62AA87D9670745AbA741746',
  },
  isolated_manta_stone: {
    comptroller: '0xBAc1e5A0B14490Dd0b32fE769eb5637183D8655d',
    oracle: '0xfD01946C35C98D71A355B8FF18d9E1697b2dd2Ea',
    wnative: '0x0Dc808adcE2099A9F62AA87D9670745AbA741746',
  },
};

async function main() {
  let data = [];
  for (const name in chains) {
    let provider = PROVIDERS[name];
    let chain = name;

    if (name === 'isolated_manta_wusdm' || name === 'isolated_manta_stone') {
      chain = 'manta';
      provider = PROVIDERS[chain];
    }

    const comptroller = new ethers.Contract(
      chains[name].comptroller,
      unitrollerABI,
      provider
    );

    const markets = await comptroller.getAllMarkets();

    console.log(name, markets.length);
    for (let market of markets) {
      console.log(market);
      if (market === '0x95B847BD54d151231f1c82Bf2EECbe5c211bD9bC') continue;
      const APYS = await getAPY(market, provider);
      const tvl = await getErc20Balances(
        market,
        chains[name].oracle,
        provider,
        chain
      );
      const ltv = await comptroller.markets(market);

      const marketData = {
        pool: `${market}-${chain}`,
        project: 'keom-protocol',
        symbol: APYS.symbol.slice(1) === "Native" ? "ETH" : APYS.symbol.slice(1),
        chain: chain,
        apyBase: APYS.supplyAPY,
        tvlUsd: tvl.tvlUsd,
        // borrow fields
        apyBaseBorrow: APYS.borrowAPY,
        totalSupplyUsd: tvl.totalSupplyUsd,
        totalBorrowUsd: tvl.totalBorrowsUsd,
        ltv: parseInt(ltv.collateralFactorMantissa) / 1e18,
      };

      data.push(marketData);
    }
  }
  return data;
}

async function getAPY(strategy, provider) {
  const contract = new ethers.Contract(strategy, keomABI, provider);

  // get the symbol
  const symbol = await contract.symbol();

  // retrieve the supply rate per timestamp for the main0vixContract
  const supplyRatePerTimestamp = await contract.supplyRatePerTimestamp();

  const supplyAPY = calculateAPY(supplyRatePerTimestamp);

  const borrowRatePerTimestamp = await contract.borrowRatePerTimestamp();
  const borrowAPY = calculateAPY(borrowRatePerTimestamp);

  return { symbol, supplyAPY, borrowAPY };
}

function calculateAPY(rate) {
  const year = 365 * 24 * 60 * 60;
  let a = 1 + rate / 1e18;
  a = parseFloat(String(a));
  const b = Math.pow(a, year);
  return (b - 1) * 100;
}

async function getErc20Balances(strategy, oracleAddress, provider, chain) {
  // retrieve the asset contract
  const oTokenContract = new ethers.Contract(strategy, keomABI, provider);

  // get decimals for the oToken
  const oDecimals = parseInt(await oTokenContract.decimals());

  // get the total supply
  const oTokenTotalSupply = await oTokenContract.totalSupply();

  // get total borrows
  const oTokenTotalBorrows = await oTokenContract.totalBorrows();

  // get the exchange rate stored
  const oExchangeRateStored = await oTokenContract.exchangeRateStored();

  let underlyingDecimals = 18;
  let native = false;
  let _address = '';
  try {
     _address = await oTokenContract.underlying()
    const _token = new ethers.Contract(
      _address,
      erc20ABI,
      provider
    );
    underlyingDecimals = await _token.decimals();
  } catch (error) {
    native = true;
  }


  // retrieve the oracle contract
  const oracle = new ethers.Contract(oracleAddress, oracleABI, provider);

  // get the underlying price of the asset from the oracle
  let oracleUnderlyingPrice = BN("0");
  let apiPrice = 0;
  try {
    const price =  await oracle.getUnderlyingPrice(strategy)
    oracleUnderlyingPrice = price
  } catch (error) {
    if(native) {
      const prices = (
        await axios.get(`https://coins.llama.fi/prices/current/${chain}:${chains[chain].wnative} `)
      ).data.coins;
      apiPrice = prices[`${chain}:${chains[chain].wnative}`]?.price;
    } else {
      const prices = (
        await axios.get(`https://coins.llama.fi/prices/current/${chain}:${_address} `)
      ).data.coins;
      apiPrice = prices[`${chain}:${_address}`]?.price;
    }
  }

  // do the conversions
  return convertTvlUSD(
    oTokenTotalSupply,
    oTokenTotalBorrows,
    oExchangeRateStored,
    oDecimals,
    underlyingDecimals,
    oracleUnderlyingPrice,
    apiPrice
  );
}

function convertUSDC(balance, exchangeRateStored, decimals) {
  return (
    (parseFloat(balance) * parseFloat(exchangeRateStored)) /
    Math.pow(1, Math.pow(10, decimals)) /
    Math.pow(1, Math.pow(10, 18))
  );
}

function convertTvlUSD(
  totalSupply,
  totalBorrows,
  exchangeRateStored,
  oDecimals,
  underlyingDecimals,
  oracleUnderlyingPrice,
  apiPrice
) {
  let totalSupplyUsd = 0;
  let totalBorrowsUsd = 0;

  if(!oracleUnderlyingPrice.isZero()) {
    let supplyUSD = exchangeRateStored.mul(oracleUnderlyingPrice).div(decimals).mul(totalSupply).div(decimals);
    let borrowUSD = totalBorrows.mul(oracleUnderlyingPrice).div(decimals);
    totalSupplyUsd = Number(ethers.utils.formatEther(supplyUSD));
    totalBorrowsUsd = Number(ethers.utils.formatEther(borrowUSD));
  } else {
    let supplyUSD = ethers.utils.formatUnits(exchangeRateStored.mul(totalSupply).div(decimals), underlyingDecimals);
    let borrowUSD = ethers.utils.formatUnits(totalBorrows, underlyingDecimals);
    totalSupplyUsd = Number(supplyUSD) * apiPrice;
    totalBorrowsUsd = Number(borrowUSD) * apiPrice;
  }
  const tvlUsd = totalSupplyUsd - totalBorrowsUsd;

  return { totalSupplyUsd, totalBorrowsUsd, tvlUsd };
}

module.exports = {
  timetravel: false,
  apy: main,
  url: 'https://app.keom.io/',
};
