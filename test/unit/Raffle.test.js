const { assert, expect } = require("chai")
const { getNamedAccounts, ethers } = require("hardhat")
const { developmentChains, networkConfig } = require("../../helper-hardhat-config")

!developmentChains.includes(network.name)
    ? describe.skip
    : describe("Raffle", () => {
          let raffle, vrfCoordinatorV2Mock, raffleEntranceFee, deployer, interval
          const chainId = network.config.chainId

          //
          beforeEach(async () => {
              deployer = (await getNamedAccounts()).deployer
              await deployments.fixture("all")
              raffle = await ethers.getContract("Raffle", deployer)
              vrfCoordinatorV2Mock = await ethers.getContract("VRFCoordinatorV2Mock", deployer)
              raffleEntranceFee = await raffle.getEntranceFee()
              interval = await raffle.getInterval()
          })

          describe("constructor", () => {
              it("initializes the raffle correctly", async () => {
                  const raffleState = await raffle.getRaffleState()
                  const interval = await raffle.getInterval()
                  assert.equal(raffleState.toString(), "0")
                  assert.equal(interval, networkConfig[chainId].interval)
              })
          })

          describe("enterRaffle", () => {
              it("reverts when you don't pay enouch", async () => {
                  //
                  await expect(raffle.enterRaffle()).to.be.revertedWith("Raffle__NotEnoughEntranceFee")
              })
              it("records players when they enter", async () => {
                  //
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  const player = await raffle.getPlayer(0)
                  assert.equal(deployer, player)
              })
              it("emits event on enter", async () => {
                  await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.emit(raffle, "RaffleEnter")
              })

              it("doesn't allow entrance when raffle is calculating", async () => {
                  //
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  await raffle.performUpkeep([])
                  await expect(raffle.enterRaffle({ value: raffleEntranceFee })).to.be.revertedWith("Raffle__NotOpen")
              })
          })
          describe("checkUpkeep", () => {
              it("returns false if people haven't sent any ETH", async () => {
                  //
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep([])
                  //   console.log(res)
                  assert(!upkeepNeeded)
              })
              it("returns false if raffle isn't open", async () => {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
                  await raffle.performUpkeep("0x")
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x")
                  //   console.log(res)
                  assert(!upkeepNeeded)
                  const raffleState = await raffle.getRaffleState()
                  assert.equal(raffleState.toString(), "1")
              })
              it("returns false if enough time hasn't passed", async () => {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() - 1])
                  await network.provider.request({ method: "evm_mine", params: [] })
                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x")
                  assert(!upkeepNeeded)
              })
              it("returns true if enough time has passed, has players, eth and is open", async () => {
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])

                  const { upkeepNeeded } = await raffle.callStatic.checkUpkeep("0x")
                  assert(upkeepNeeded)
              })
          })
          describe("performUpkeep", () => {
              it("can only run if checkUpkeep is true", async () => {
                  //
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])

                  const tx = await raffle.performUpkeep([])
                  assert(tx)
              })
              it("reverts when checkUpkeep is false", async () => {
                  //
                  await expect(raffle.performUpkeep([])).to.be.revertedWith("Raffle__UpkeepNotNeeded(0, 0, 0)")
              })
              it("updates the raffle state, emits an event and calls the vrf coordinator", async () => {
                  //
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])

                  const txResponse = await raffle.performUpkeep([])
                  const txReceipt = await txResponse.wait(1)
                  const requestId1 = txReceipt.events[1].args.requestId
                  //   const requestId0 = txReceipt.events[0].args.requestId
                  const raffleState = await raffle.getRaffleState()

                  //   assert(requestId0.toNumber() > 0)
                  assert(requestId1.toNumber() > 0)
                  //   assert.equal(requestId0, requestId1)
                  assert(raffleState == 1) // 0=OPEN, 1=CALCULATING
              })
          })
          describe("fulfillRandomWords", () => {
              beforeEach(async () => {
                  //
                  await raffle.enterRaffle({ value: raffleEntranceFee })
                  await network.provider.send("evm_increaseTime", [interval.toNumber() + 1])
                  await network.provider.send("evm_mine", [])
              })
              //
              it("can only be called after performUpkeep", async () => {
                  //
                  await expect(vrfCoordinatorV2Mock.fulfillRandomWords(0, raffle.address)).to.be.revertedWith(
                      "nonexistent request"
                  )
                  await expect(vrfCoordinatorV2Mock.fulfillRandomWords(1, raffle.address)).to.be.revertedWith(
                      "nonexistent request"
                  )
              })
              it("picks a winner, resets the lottery, and sends money", async () => {
                  //
                  const additionalEntrances = 3
                  const startingAccountIndex = 1 // deployer = 0, other players start at 1
                  const accounts = await ethers.getSigners()

                  for (let i = startingAccountIndex; i < startingAccountIndex + additionalEntrances; i++) {
                      //
                      const accountConnectedRaffle = await raffle.connect(accounts[i])
                      await accountConnectedRaffle.enterRaffle({ value: raffleEntranceFee })
                  }
                  const startingTimestamp = await raffle.getLastTimestamp()

                  // performUpkeep (mock being chainlink keeper)
                  // fulfillRandomWords (mock being chainlink VRF)
                  // we will have to wait for the fulfillRandomWords to be called

                  await new Promise(async (resolve, reject) => {
                      //
                      raffle.once("WinnerPicked", async () => {
                          //
                          console.log("WinnerPicked event fired!")

                          try {
                              //
                              const recentWinner = await raffle.getRecentWinner()
                              const raffleState = await raffle.getRaffleState()
                              const endingTimestamp = await raffle.getLastTimestamp()
                              const numberOfPlayers = await raffle.getNumberOfPlayers()
                              const winnerBalance = await await accounts[1].getBalance()

                              assert.equal(recentWinner, accounts[1].address)
                              assert.equal(raffleState.toString(), "0")
                              assert.equal(numberOfPlayers.toString(), "0")
                              assert(endingTimestamp > startingTimestamp)
                              assert.equal(
                                  winnerBalance.toString(),
                                  startingBalance // startingBalance + ( (raffleEntranceFee * additionalEntrances) + raffleEntranceFee )
                                      .add(raffleEntranceFee.mul(additionalEntrances).add(raffleEntranceFee))
                                      .toString()
                              )
                          } catch (err) {
                              reject(err)
                          }
                          resolve()
                      })
                      // Setting up listener
                      // Fire the event, listener will pick it up, and resolve
                      const txResponse = await raffle.performUpkeep([])
                      const txReceipt = await txResponse.wait(1)
                      const startingBalance = await accounts[1].getBalance()
                      await vrfCoordinatorV2Mock.fulfillRandomWords(txReceipt.events[1].args.requestId, raffle.address)
                  })
              })
          })
      })
