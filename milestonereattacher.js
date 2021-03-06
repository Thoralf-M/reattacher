
const { asTransactionObject, asTransactionTrytes } = require('@iota/transaction-converter');
const bundleValidator = require('@iota/bundle-validator');
const { composeAPI } = require('@iota/core')
const zmq = require("zeromq")

const iota = composeAPI({
  provider: 'http://127.0.0.1:15265'
})
let address = 'PROMOTETANGLEBAYPROMOTETANGLEBAYPROMOTETANGLEBAYPROMOTETANGLEBAYPROMOTETANGLEBAYP'
let tag = 'PROMOTETANGLEBAY'
let transfers = [{
  value: 0,
  address,
  tag
}]

let tcpNodes = ["tcp://node04.iotatoken.nl:5556"]
let latestMilestone = ''
let bundles = {}
let reattachedTails = []
let reattachmentIntervall = 90000
let maxReattachTries = 10

let blockedTags = ['ANDROID9WALLET9TRANSFER9999', 'THE9IOTA9MIXER9BETA99999999', 'TANGLE9BEAT9999999999999999', 'IOTA9FAUCET9999999999999999']
let blockedAddresses = ['KSNWNNLGLHIBVFMULCEXDQLXMGGVKLACPPDNKSQYLBPPHISXGCNDZHEGCTQII9PRMRB9TXTBZ9BZTOSGW']
let maxBundleSize = 20
let amountPromoteTxs = 10

async function run() {
  const sock = new zmq.Subscriber
  for (node of tcpNodes) {
    sock.connect(node)
  }
  sock.subscribe("lmhs")
  sock.subscribe("tx")

  for await (const msg of sock) {
    const data = msg.toString().split(' ')
    switch (
    data[0]
    ) {
      case 'lmhs': latestMilestone = data[1]
        // console.log("New milestone", latestMilestone);
        break
      case 'tx':
        if (data[6] == 0 && blockedTags.indexOf(data[12]) == -1 && blockedAddresses.indexOf(data[2]) == -1) {
          // console.log(data[11]);
          randomTailTx = data[1]
          //value > 0; index == 0; bundlesize <= maxBundleSize; check if not already known
          if (data[3] > 0 && data[6] == 0 && data[7] < maxBundleSize && !(data[8] in bundles)) {
            checkBundleInputs(data[1])
          }
        }
    }
  }
}
run()

function sortBundle(txObjects) {
  let filtered = txObjects.filter((obj, index, self) =>
    index === self.findIndex((t) => (
      t.currentIndex === obj.currentIndex
    ))
  )
  filtered.sort((a, b) => {
    return a.currentIndex - b.currentIndex;
  });
  return filtered
}

async function checkBundleInputs(txhash) {
  try {
    let txObject = await iota.getTransactionObjects([txhash]);
    let bundleObjects = await iota.findTransactionObjects({ bundles: [txObject[0].bundle] })
    let sortedBundle = sortBundle(bundleObjects)
    //validate bundle
    if (bundleValidator.default(sortedBundle)) {
      // console.log("valid bundle", txObject[0].bundle);
    } else {
      console.log("invalid bundle https://thetangle.org/bundle/" + txObject[0].bundle);
      return
    }
    for (let index = 0; index < sortedBundle.length; index++) {
      if (sortedBundle[index].value < 0) {
        if (blockedAddresses.indexOf(sortedBundle[index].address) != -1) {
          console.log("Blocked address found", txhash);
          return
        }
        let { balances } = await iota.getBalances([sortedBundle[index].address], 100)
        if (Math.abs(balances[0]) < Math.abs(sortedBundle[index].value)) {
          // console.log('Balance to send: ' + sortedBundle[index].value + ', available: ' + balances[0])
          // console.log('Not enough balance at ' + sortedBundle[index].address)
          return
        }
      }
    }
    console.log("New bundle to reattach: https://thetangle.org/transaction/" + txhash);
    let bundleTrytes = sortedBundle.map(tx => asTransactionTrytes(tx))
    bundles[sortedBundle[0].bundle] = { bundlehash: sortedBundle[0].bundle, trytes: bundleTrytes.reverse(), lastTime: 0, tries: 0 }
  } catch (err) {
    console.log(err);
  }
}

async function spam() {
  while (true) {
    try {
      //wait five seconds
      await new Promise(resolve => setTimeout(resolve, 5000));
      //wait for milestone
      if (latestMilestone == '') {
        continue
      }
      for (let [bundlehash, bundle] of Object.entries(bundles)) {
        try {
          if (Date.now() - bundle.lastTime < reattachmentIntervall) {
            // console.log("don't reattach, wait");
            continue
          } {
            if (bundle.tries > maxReattachTries) {
              console.log("maxReattachTries reached for", bundlehash);
              delete bundles[bundlehash]
              continue
            }
            bundles[bundlehash].tries++
            console.log("reattach after s:" + (Date.now() - bundle.lastTime) / 1000);
          }
          let bundleObjects = await iota.findTransactionObjects({
            bundles: [bundlehash],
          })
          let allTailTxsofBundle = bundleObjects
            .filter((tx) => tx.currentIndex == 0)
            .map((tx) => tx.hash)
          let inclusionStates = await iota.getLatestInclusion(allTailTxsofBundle)
          if (inclusionStates.indexOf(true) == -1) {
            //reattach
            let tail = await reattach(bundle.trytes)
            await sendPromoteTxs(tail, amountPromoteTxs)
            //update time
            bundles[bundlehash].lastTime = Date.now()
            //wait 1s per tx ()
            console.log("wait seconds: " + (bundleObjects[0].lastIndex + 1) * 1000);
            await new Promise(resolve => setTimeout(resolve, (bundleObjects[0].lastIndex + 1) * 1000));
          } else {
            console.log("bundle confirmed: https://thetangle.org/bundle/" + bundlehash);
            delete bundles[bundlehash]
            console.log("Unconfirmed bundles: ", Object.keys(bundles));
          }
        } catch (e) {
          console.log('Problem with reattachment', e)
        }
      }
    } catch (e) {
      console.log(e)
    }
  }
}
spam()

async function reattach(trytes) {
  try {
    let attachedTrytes = await iota.attachToTangle(latestMilestone, latestMilestone, 14, trytes)
    await iota.storeAndBroadcast(attachedTrytes)
    let replayhash = asTransactionObject(attachedTrytes[0]).hash
    reattachedTails.push(replayhash)
    if (reattachedTails.length > 2) {
      reattachedTails.shift()
    }
    console.log('Reattached transaction: https://thetangle.org/transaction/' + replayhash)
    return replayhash
  } catch (e) {
    console.error(e)
  }
}

async function sendPromoteTxs(txhash, amount) {
  try {
    let trytes = await iota.prepareTransfers(address, transfers)
    if (amount < 5) {
      if (amount % 2 == 0) {
        tips = await iota.getTransactionsToApprove(3, txhash)
        attachedTrytes = await iota.attachToTangle(txhash, tips.branchTransaction, 14, trytes)
      } else {
        attachedTrytes = await iota.attachToTangle(txhash, tips.trunkTransaction, 14, trytes)
      }
    } else {
      attachedTrytes = await iota.attachToTangle(txhash, latestMilestone, 14, trytes)
    }
    await iota.storeAndBroadcast(attachedTrytes)
    console.log('Promotetx: https://thetangle.org/transaction/' + asTransactionObject(attachedTrytes[0]).hash)
    amount--
    if (amount > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      await sendPromoteTxs(txhash, amount)
    }
  } catch (e) {
    console.log(e)
  }
}