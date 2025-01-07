// let cameras = JSON.parse(document.getElementById("cameras").innerText)
const currentCam = 1

document.addEventListener('keydown', function (event) {
  const key = event.key

  // try {
  //   let cam = parseInt(key)

  //   if (cam > 0 && cam <= cameras.length) {
  //     currentCam = cam
  //     document.getElementById("logo").style.display = "none"
  //     document.getElementById("camerafeed").src = `http://${cameras[cam-1].ip}/axis-cgi/mjpg/video.cgi?resolution=1280x720&camera=1`
  //     console.log("Switching to camera: " + (cam))
  //   } else {
  //     throw new Error()
  //   }
  // } catch (e) {
  //   console.log("Not a valid choice: ", e)
  // }

  switch (key) {
    case '*':
      // shutdown
      break
    case '-':
      // refresh camera list
      break
    case '+':
      // main menu
      break
    case '1':
      // delay single cam
      const delay = prompt('Ange önskad delay', '0')
      if (delay != null) {
        console.log(delay)
      }
      break
    case '2':
      // delay singlecam quadview
      break
    case '3':
      // delay doublecam
      break
  }
})
